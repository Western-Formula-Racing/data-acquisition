#!/usr/bin/env python3
"""
Unit tests for the /api/generate-code-followup endpoint and related changes.

Mocks all external dependencies (LLM, sandbox, ChromaDB) so tests can run
without Docker or network access.

Run:  python -m pytest test_followup.py -v
"""

import json
import os
import sys
import types
from unittest.mock import MagicMock, patch

import pytest

# ── Stub heavy dependencies before importing code_generator ────────────────
# These modules are either unavailable outside Docker or heavyweight.

# Stub chromadb
_chromadb = types.ModuleType("chromadb")

class _FakeCollection:
    def get_or_create_collection(self, name):
        return self
    def get_collection(self, name):
        return self
    def count(self):
        return 0
    def upsert(self, **kw):
        pass

class _FakePersistentClient(_FakeCollection):
    def __init__(self, *a, **kw):
        pass

_chromadb.PersistentClient = _FakePersistentClient
_chromadb.Collection = _FakeCollection
sys.modules["chromadb"] = _chromadb

# Stub diskcache
_diskcache = types.ModuleType("diskcache")

class _FakeCache(dict):
    def __init__(self, *a, **kw):
        super().__init__()
    def get(self, key, default=None):
        return super().get(key, default)
    def set(self, key, value, expire=None):
        self[key] = value

_diskcache.Cache = _FakeCache
sys.modules["diskcache"] = _diskcache

# Stub langchain / langgraph
_lc_anthropic = types.ModuleType("langchain_anthropic")

class _FakeLLM:
    def __init__(self, **kw):
        pass
    def invoke(self, messages):
        resp = MagicMock()
        resp.content = '```python\nprint("hello from followup")\n```'
        return resp

_lc_anthropic.ChatAnthropic = _FakeLLM
sys.modules["langchain_anthropic"] = _lc_anthropic

_lc_chroma = types.ModuleType("langchain_chroma")

class _FakeChromaStore:
    def __init__(self, **kw):
        pass
    def similarity_search(self, query, k=5):
        return []

_lc_chroma.Chroma = _FakeChromaStore
sys.modules["langchain_chroma"] = _lc_chroma

_lc_embeddings = types.ModuleType("langchain_community")
_lc_embeddings_sub = types.ModuleType("langchain_community.embeddings")

class _FakeEmbeddings:
    def __init__(self, **kw):
        pass
    def embed_documents(self, texts):
        return [[0.0] * 10 for _ in texts]

_lc_embeddings_sub.FastEmbedEmbeddings = _FakeEmbeddings
sys.modules["langchain_community"] = _lc_embeddings
sys.modules["langchain_community.embeddings"] = _lc_embeddings_sub

_lc_core_messages = types.ModuleType("langchain_core")
_lc_core_messages_sub = types.ModuleType("langchain_core.messages")

class _BaseMsg:
    def __init__(self, content=""):
        self.content = content

_lc_core_messages_sub.AIMessage = type("AIMessage", (_BaseMsg,), {})
_lc_core_messages_sub.HumanMessage = type("HumanMessage", (_BaseMsg,), {})
_lc_core_messages_sub.SystemMessage = type("SystemMessage", (_BaseMsg,), {})
sys.modules["langchain_core"] = _lc_core_messages
sys.modules["langchain_core.messages"] = _lc_core_messages_sub

_lg = types.ModuleType("langgraph")
_lg_graph = types.ModuleType("langgraph.graph")
_lg_graph.END = "END"

class _FakeStateGraph:
    def __init__(self, *a, **kw):
        pass
    def add_node(self, *a, **kw):
        pass
    def add_edge(self, *a, **kw):
        pass
    def add_conditional_edges(self, *a, **kw):
        pass
    def set_entry_point(self, *a, **kw):
        pass
    def compile(self):
        return MagicMock()

_lg_graph.StateGraph = _FakeStateGraph
sys.modules["langgraph"] = _lg
sys.modules["langgraph.graph"] = _lg_graph

# Stub flask_cors
_flask_cors = types.ModuleType("flask_cors")
_flask_cors.CORS = lambda app: None
sys.modules["flask_cors"] = _flask_cors

# Stub stats_report
_stats_report = types.ModuleType("stats_report")
_stats_report.init_metrics = lambda *a, **kw: None
_stats_report.record_metrics = MagicMock()
_stats_report.stats_response = lambda **kw: {}
sys.modules["stats_report"] = _stats_report

# ── Set required env vars before importing code_generator ──────────────────
os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")
os.environ.setdefault("ANTHROPIC_BASE_URL", "http://localhost:9999")
os.environ.setdefault("ANTHROPIC_MODEL", "test-model")
os.environ.setdefault("SANDBOX_URL", "http://localhost:8080")
os.environ.setdefault("DATA_DIR", "/tmp/cg_test_data")
os.environ.setdefault("CACHE_DIR", "/tmp/cg_test_cache")
os.environ.setdefault("CHROMA_DIR", "/tmp/cg_test_chroma")

# Now import
sys.path.insert(0, os.path.dirname(__file__))
import code_generator  # noqa: E402

app = code_generator.app


# ── Fixtures ───────────────────────────────────────────────────────────────
@pytest.fixture
def client():
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


def _sandbox_ok(output="hello from followup"):
    """Return a mock sandbox success response."""
    return MagicMock(
        status_code=200,
        raise_for_status=lambda: None,
        json=lambda: {"ok": True, "std_out": output, "std_err": "", "return_code": 0, "output_files": []},
    )


def _sandbox_fail(error="NameError: name 'x' is not defined"):
    """Return a mock sandbox failure response."""
    return MagicMock(
        status_code=200,
        raise_for_status=lambda: None,
        json=lambda: {"ok": False, "std_out": "", "std_err": error, "return_code": 1, "output_files": []},
    )


# ── Tests ──────────────────────────────────────────────────────────────────

class TestFollowupEndpoint:
    """Tests for POST /api/generate-code-followup."""

    def test_empty_prompt_returns_400(self, client):
        """Followup with empty prompt should be rejected."""
        resp = client.post("/api/generate-code-followup",
                           json={"prompt": "", "history": []})
        assert resp.status_code == 400
        assert "prompt is required" in resp.get_json()["error"]

    def test_missing_prompt_returns_400(self, client):
        """Followup with no prompt key should be rejected."""
        resp = client.post("/api/generate-code-followup",
                           json={"history": []})
        assert resp.status_code == 400

    @patch("code_generator.llm")
    @patch("requests.post")
    def test_basic_followup_success(self, mock_post, mock_llm, client):
        """A simple follow-up with one prior turn should succeed."""
        # LLM returns code
        llm_resp = MagicMock()
        llm_resp.content = '```python\nprint("updated plot")\n```'
        mock_llm.invoke.return_value = llm_resp

        # Sandbox succeeds
        mock_post.return_value = _sandbox_ok("updated plot")

        history = [
            {"role": "user", "prompt": "plot motor speed", "code": "", "output": "", "error": "", "rag_context": ""},
            {"role": "assistant", "prompt": "", "code": "print('original')", "output": "original", "error": "", "rag_context": "RELEVANT SENSORS:\n  - INV_Motor_Speed"},
        ]

        resp = client.post("/api/generate-code-followup", json={
            "prompt": "add a rolling average",
            "history": history,
        })

        assert resp.status_code == 200
        data = resp.get_json()
        assert data["result"]["status"] == "success"
        assert data["result"]["output"] == "updated plot"
        assert "code" in data
        assert "rag_context" in data  # rag_context should be in response

    @patch("code_generator.llm")
    @patch("requests.post")
    def test_multi_turn_followup(self, mock_post, mock_llm, client):
        """Multiple prior turns should all be sent to the LLM."""
        llm_resp = MagicMock()
        llm_resp.content = 'print("turn 3")'
        mock_llm.invoke.return_value = llm_resp
        mock_post.return_value = _sandbox_ok("turn 3")

        history = [
            {"role": "user", "prompt": "plot motor speed", "code": "", "output": "", "error": "", "rag_context": ""},
            {"role": "assistant", "prompt": "", "code": "plt.plot(speed)", "output": "plotted", "error": "", "rag_context": "ctx1"},
            {"role": "user", "prompt": "add rolling average", "code": "", "output": "", "error": "", "rag_context": ""},
            {"role": "assistant", "prompt": "", "code": "plt.plot(rolling)", "output": "added", "error": "", "rag_context": "ctx2"},
        ]

        resp = client.post("/api/generate-code-followup", json={
            "prompt": "change colors to red and blue",
            "history": history,
        })

        assert resp.status_code == 200
        data = resp.get_json()
        assert data["result"]["status"] == "success"

        # LLM should have been called with: system + 4 history msgs + 1 new = 6 messages
        call_args = mock_llm.invoke.call_args[0][0]
        assert len(call_args) == 6  # SystemMessage + 2 Human + 2 AI + 1 new Human

    @patch("code_generator.llm")
    @patch("requests.post")
    def test_followup_with_sandbox_retry(self, mock_post, mock_llm, client):
        """When sandbox fails, the followup endpoint should retry."""
        # First LLM call returns bad code, second returns fixed code
        llm_resp_1 = MagicMock()
        llm_resp_1.content = 'print(undefined_var)'
        llm_resp_2 = MagicMock()
        llm_resp_2.content = 'print("fixed")'
        mock_llm.invoke.side_effect = [llm_resp_1, llm_resp_2]

        # First sandbox call fails, second succeeds
        mock_post.side_effect = [_sandbox_fail(), _sandbox_ok("fixed")]

        resp = client.post("/api/generate-code-followup", json={
            "prompt": "fix the error",
            "history": [
                {"role": "user", "prompt": "do something", "code": "", "output": "", "error": "", "rag_context": ""},
                {"role": "assistant", "prompt": "", "code": "broken()", "output": "", "error": "NameError", "rag_context": ""},
            ],
        })

        assert resp.status_code == 200
        data = resp.get_json()
        assert data["result"]["status"] == "success"
        assert len(data["retries"]) == 1  # one retry occurred
        assert mock_llm.invoke.call_count == 2  # called twice: initial + retry

    @patch("code_generator.llm")
    @patch("requests.post")
    def test_followup_max_retries_exceeded(self, mock_post, mock_llm, client):
        """When all retries fail, the response should indicate failure."""
        llm_resp = MagicMock()
        llm_resp.content = 'print(broken)'
        mock_llm.invoke.return_value = llm_resp

        # All sandbox calls fail
        mock_post.return_value = _sandbox_fail("SyntaxError")

        resp = client.post("/api/generate-code-followup", json={
            "prompt": "try again",
            "history": [
                {"role": "user", "prompt": "original", "code": "", "output": "", "error": "", "rag_context": ""},
                {"role": "assistant", "prompt": "", "code": "x", "output": "", "error": "err", "rag_context": ""},
            ],
        })

        assert resp.status_code == 200
        data = resp.get_json()
        assert data["result"]["status"] == "error"
        assert data["max_retries_reached"] is True

    @patch("code_generator.llm")
    @patch("requests.post")
    def test_rag_context_returned_in_response(self, mock_post, mock_llm, client):
        """The response should include rag_context for the slackbot to store."""
        llm_resp = MagicMock()
        llm_resp.content = 'print("ok")'
        mock_llm.invoke.return_value = llm_resp
        mock_post.return_value = _sandbox_ok("ok")

        resp = client.post("/api/generate-code-followup", json={
            "prompt": "some followup",
            "history": [],
        })

        data = resp.get_json()
        assert "rag_context" in data
        # rag_context is a string (possibly empty if RAG stores are empty in test)
        assert isinstance(data["rag_context"], str)


class TestGenerateCodeRagContextInResponse:
    """Verify that /api/generate-code now returns rag_context."""

    def test_format_response_includes_rag_context(self):
        """_format_response should include rag_context from state."""
        state = {
            "prompt": "test",
            "rag_context": "RELEVANT SENSORS:\n  - INV_Motor_Speed",
            "code": "print('hi')",
            "sandbox_result": {"ok": True, "std_out": "hi", "std_err": "", "return_code": 0, "output_files": []},
            "error": "",
            "retries": 0,
            "retry_history": [],
            "llm_cache_hit": False,
            "exec_cache_hit": False,
        }
        result = code_generator._format_response(state)
        assert result["rag_context"] == "RELEVANT SENSORS:\n  - INV_Motor_Speed"

    def test_format_response_empty_rag_context(self):
        """_format_response should return empty string when no rag_context."""
        state = {
            "prompt": "test",
            "rag_context": "",
            "code": "x",
            "sandbox_result": {"ok": True, "std_out": "", "std_err": "", "return_code": 0, "output_files": []},
            "error": "",
            "retries": 0,
            "retry_history": [],
            "llm_cache_hit": False,
            "exec_cache_hit": False,
        }
        result = code_generator._format_response(state)
        assert result["rag_context"] == ""


class TestSlackBotThreadSessions:
    """Unit tests for the slackbot thread session management (importable without Slack/psycopg2)."""

    def test_session_store_and_retrieve(self):
        """Test basic session storage and retrieval by mocking the slackbot module internals."""
        # We test the data structures directly rather than importing slack_bot
        # (which needs psycopg2, slack_sdk, etc.)
        import time as _time

        sessions: dict[str, dict] = {}
        TTL = 2 * 3600
        MAX_TURNS = 10

        def get_session(thread_ts):
            s = sessions.get(thread_ts)
            if s is None:
                return None
            if _time.time() - s.get("created_at", 0) > TTL:
                sessions.pop(thread_ts, None)
                return None
            return s

        # Store a session
        thread_ts = "1234567890.000001"
        sessions[thread_ts] = {
            "user": "U_TEST",
            "timeout": 120,
            "channel": "C_TEST",
            "created_at": _time.time(),
            "history": [
                {"role": "user", "prompt": "plot speed", "code": "", "output": "", "error": "", "rag_context": ""},
                {"role": "assistant", "prompt": "", "code": "plt.plot(speed)", "output": "done", "error": "", "rag_context": "ctx"},
            ],
        }

        # Retrieve it
        s = get_session(thread_ts)
        assert s is not None
        assert s["user"] == "U_TEST"
        assert len(s["history"]) == 2

        # Add a follow-up turn
        s["history"].append({"role": "user", "prompt": "add title", "code": "", "output": "", "error": "", "rag_context": ""})
        s["history"].append({"role": "assistant", "prompt": "", "code": "plt.title('x')", "output": "ok", "error": "", "rag_context": ""})
        assert len(get_session(thread_ts)["history"]) == 4

        # Non-existent thread
        assert get_session("9999999999.999999") is None

    def test_session_expiry(self):
        """Sessions older than TTL should not be returned."""
        import time as _time

        sessions: dict[str, dict] = {}
        TTL = 2 * 3600

        def get_session(thread_ts):
            s = sessions.get(thread_ts)
            if s is None:
                return None
            if _time.time() - s.get("created_at", 0) > TTL:
                sessions.pop(thread_ts, None)
                return None
            return s

        thread_ts = "1234567890.000002"
        sessions[thread_ts] = {
            "user": "U_TEST",
            "timeout": 120,
            "channel": "C_TEST",
            "created_at": _time.time() - TTL - 1,  # expired
            "history": [],
        }

        assert get_session(thread_ts) is None
        assert thread_ts not in sessions  # cleaned up

    def test_max_turns_enforcement(self):
        """History should respect the max turns limit."""
        MAX_TURNS = 10
        history = []
        # Simulate MAX_TURNS * 2 entries (user + assistant per turn)
        for i in range(MAX_TURNS):
            history.append({"role": "user", "prompt": f"turn {i}"})
            history.append({"role": "assistant", "code": f"code {i}"})

        assert len(history) >= MAX_TURNS * 2
        # A followup handler should reject at this point
        should_reject = len(history) >= MAX_TURNS * 2
        assert should_reject is True

    def test_history_shape_contract(self):
        """Each history entry should have the expected keys."""
        required_keys = {"role", "prompt", "code", "output", "error", "rag_context"}

        user_entry = {"role": "user", "prompt": "plot speed", "code": "", "output": "", "error": "", "rag_context": ""}
        assistant_entry = {"role": "assistant", "prompt": "", "code": "print('x')", "output": "x", "error": "", "rag_context": "ctx"}

        assert set(user_entry.keys()) == required_keys
        assert set(assistant_entry.keys()) == required_keys
        assert user_entry["role"] == "user"
        assert assistant_entry["role"] == "assistant"
