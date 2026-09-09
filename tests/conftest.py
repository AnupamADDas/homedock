import os
import tempfile
from pathlib import Path
import pytest

# Configure isolated HOMEDOCK_DATA_DIR before any app imports
_test_data_dir = tempfile.TemporaryDirectory()
os.environ["HOMEDOCK_DATA_DIR"] = _test_data_dir.name
os.environ["HOMEDOCK_ADMIN_PASSWORD"] = "homedock2026!"

# Preserve the running aria2 secret so test RPC calls authenticate properly
real_secret_file = Path(__file__).resolve().parent.parent / "data" / ".aria2_secret"
if real_secret_file.exists():
    os.environ["HOMEDOCK_ARIA2_SECRET"] = real_secret_file.read_text().strip()

from app.database import init_db

@pytest.fixture(scope="session", autouse=True)
def init_test_database():
    init_db()
    yield
    _test_data_dir.cleanup()
