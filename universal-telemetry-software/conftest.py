from pathlib import Path
import sys

CONE_DETECTION_PATH = Path(__file__).parent / "cone-detection"
if str(CONE_DETECTION_PATH) not in sys.path:
    sys.path.insert(0, str(CONE_DETECTION_PATH))
