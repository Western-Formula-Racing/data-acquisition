#!/bin/bash
# Local developer test runner.
# Usage:
#   ./run_ci_tests.sh            # Full run: build images, start stack, run tests
#   ./run_ci_tests.sh --no-build # Skip image build (stack already running)
#   ./run_ci_tests.sh --unit     # Run only unit tests (no containers needed)
set -e

echo "========================================="
echo "Universal Telemetry CI/CD Test Suite"
echo "========================================="

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Flags
NO_BUILD=false
UNIT_ONLY=false
for arg in "$@"; do
  case $arg in
    --no-build) NO_BUILD=true ;;
    --unit)     UNIT_ONLY=true ;;
  esac
done

# Cleanup function
cleanup() {
    set +e  # Prevent cleanup errors from overriding the test exit code
    if [ "$NO_BUILD" = false ] && [ "$UNIT_ONLY" = false ]; then
        echo -e "\n${YELLOW}Cleaning up test environment...${NC}"
        # compose down -v already removes the project network; skip network prune
        # to avoid zsh sort-specifier errors from docker network prune output.
        docker compose -f deploy/docker-compose.test.yml down -v 2>/dev/null || true
        docker compose -f deploy/docker-compose.can-test.yml down -v 2>/dev/null || true
    fi
}
trap cleanup EXIT

# ── Unit tests ───────────────────────────────────────────────────────────────
echo -e "\n${YELLOW}Running unit tests (no containers)...${NC}"
uv sync --frozen --extra dev
uv run -- python -m pytest tests/test_leds.py tests/test_influx_bridge.py -v || {
    echo -e "${RED}✗ Unit tests failed${NC}"
    exit 1
}
echo -e "${GREEN}✓ Unit tests passed${NC}"

[ "$UNIT_ONLY" = true ] && { echo -e "\n${GREEN}✓ Unit-only run complete${NC}"; exit 0; }

# ── Docker image build ───────────────────────────────────────────────────────
if [ "$NO_BUILD" = false ]; then
    echo -e "\n${YELLOW}Building Docker image...${NC}"
    docker build -t universal-telemetry:test . || {
        echo -e "${RED}✗ Docker build failed${NC}"
        exit 1
    }
    echo -e "${GREEN}✓ Docker image built${NC}"
fi

# ── Validate compose configs ─────────────────────────────────────────────────
echo -e "\n${YELLOW}Validating compose configs...${NC}"
docker compose -f deploy/docker-compose.yml config --quiet
docker compose -f deploy/docker-compose.test.yml config --quiet
docker compose -f deploy/docker-compose.can-test.yml config --quiet
echo -e "${GREEN}✓ All compose configs valid${NC}"

# ── Start test environment ───────────────────────────────────────────────────
if [ "$NO_BUILD" = false ]; then
    echo -e "\n${YELLOW}Starting test stack (TimescaleDB)...${NC}"
    docker compose -f deploy/docker-compose.test.yml up -d --build || {
        echo -e "${RED}✗ Failed to start containers${NC}"
        exit 1
    }
    echo -e "${GREEN}✓ Containers started${NC}"
    echo "Waiting for services to stabilise (20s)..."
    sleep 20
fi

# ── Verify containers ────────────────────────────────────────────────────────
echo -e "\n${YELLOW}Verifying containers...${NC}"
docker compose -f deploy/docker-compose.test.yml ps

for container in daq-car daq-base daq-car-redis daq-base-redis daq-pecan-test daq-test-influxdb3; do
    if docker ps --format '{{.Names}}' | grep -q "^${container}$"; then
        echo -e "${GREEN}✓ ${container} running${NC}"
    else
        echo -e "${RED}✗ ${container} NOT running${NC}"
        docker logs "${container}" 2>&1 || true
        exit 1
    fi
done

# ── Initial logs ─────────────────────────────────────────────────────────────
echo -e "\n${YELLOW}Recent container logs...${NC}"
docker logs daq-base  --tail 20 2>&1 || true
docker logs daq-test-influxdb3 --tail 10 2>&1 || true

# ── Integration tests ────────────────────────────────────────────────────────
echo -e "\n${YELLOW}Running integration tests...${NC}"
uv run -- python -m pytest tests/test_integration.py -v -s --timeout=120 || {
    TEST_EXIT_CODE=$?
    echo -e "\n${RED}✗ Integration tests failed${NC}"

    mkdir -p test-logs
    docker compose -f deploy/docker-compose.test.yml logs --no-color > test-logs/docker-compose.log 2>&1
    docker logs daq-car            > test-logs/car.log 2>&1 || true
    docker logs daq-base           > test-logs/base.log 2>&1 || true
    docker logs daq-car-redis      > test-logs/car-redis.log 2>&1 || true
    docker logs daq-base-redis     > test-logs/base-redis.log 2>&1 || true
    docker logs daq-pecan-test     > test-logs/pecan.log 2>&1 || true
    docker logs daq-test-influxdb3 > test-logs/influxdb3.log 2>&1 || true
    echo -e "${YELLOW}Logs saved to test-logs/${NC}"
    exit $TEST_EXIT_CODE
}

# Step 7: Run WebSocket v2 protocol tests
echo -e "\n${YELLOW}Step 7: Running WebSocket v2 protocol tests...${NC}"
uv run -- python -m pytest tests/test_websocket_v2.py -v -s || {
    TEST_EXIT_CODE=$?
    echo -e "\n${RED}✗ WebSocket v2 tests failed${NC}"

    mkdir -p test-logs
    docker compose -f deploy/docker-compose.test.yml logs --no-color > test-logs/docker-compose.log 2>&1
    docker logs daq-car            > test-logs/car.log 2>&1 || true
    docker logs daq-base           > test-logs/base.log 2>&1 || true
    docker logs daq-test-influxdb3 > test-logs/influxdb3.log 2>&1 || true
    echo -e "${YELLOW}Logs saved to test-logs/${NC}"
    exit $TEST_EXIT_CODE
}

# ── Tear down integration stack before vCAN tests ─────────────────────────────
echo -e "\n${YELLOW}Tearing down integration test stack...${NC}"
docker compose -f deploy/docker-compose.test.yml down -v 2>/dev/null || true

# ── vCAN pipeline tests ──────────────────────────────────────────────────────
# Requires: can0 (vcan or physical) UP, can-utils installed
if ip link show can0 &>/dev/null; then
    echo -e "\n${YELLOW}Running vCAN pipeline tests (can0 detected)...${NC}"

    docker compose -f deploy/docker-compose.can-test.yml up -d --build || {
        echo -e "${RED}✗ Failed to start vCAN test stack${NC}"
        exit 1
    }
    echo "Waiting for telemetry container to start CAN reader (15s)..."
    sleep 15

    # Verify real CAN mode
    if docker logs daq-can-test 2>&1 | grep -q "CAN Reader started on can0"; then
        echo -e "${GREEN}✓ Container is reading real can0${NC}"
    else
        echo -e "${RED}✗ Container did NOT start real CAN reader${NC}"
        docker logs daq-can-test 2>&1
        exit 1
    fi

    uv run -- python -m pytest tests/test_can_pipeline.py -v -s --timeout=60 || {
        TEST_EXIT_CODE=$?
        echo -e "\n${RED}✗ vCAN pipeline tests failed${NC}"

        mkdir -p test-logs
        docker logs daq-can-test       > test-logs/can-test.log 2>&1 || true
        docker logs daq-can-test-redis > test-logs/can-test-redis.log 2>&1 || true
        echo -e "${YELLOW}Logs saved to test-logs/${NC}"
        exit $TEST_EXIT_CODE
    }
    echo -e "${GREEN}✓ vCAN pipeline tests passed${NC}"

    docker compose -f deploy/docker-compose.can-test.yml down -v 2>/dev/null || true
else
    echo -e "\n${YELLOW}Skipping vCAN pipeline tests (can0 not found)${NC}"
    echo -e "${YELLOW}  To run: sudo modprobe vcan && sudo ip link add dev can0 type vcan && sudo ip link set up can0${NC}"
fi

echo -e "\n${GREEN}=========================================${NC}"
echo -e "${GREEN}✓ All tests passed!${NC}"
echo -e "${GREEN}=========================================${NC}"
exit 0
