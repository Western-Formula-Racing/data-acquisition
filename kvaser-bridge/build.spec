# PyInstaller spec for kvaser-bridge
# Build:
#   Linux:   pyinstaller build.spec
#   Windows: pyinstaller build.spec
#
# Prerequisites (must be installed separately by the end user):
#   - Kvaser CANlib SDK  (https://kvaser.com/download/)
#
# Keep this file in git; CI uses it to produce release artifacts.

import platform

is_windows = platform.system() == 'Windows'
is_macos = platform.system() == 'Darwin'

a = Analysis(
    ['src/main.py'],
    pathex=['src'],
    datas=[
        ('src/bridge.crt', '.'),
        ('src/bridge.key', '.'),
    ],
    hiddenimports=[
        'can.interfaces.kvaser',
        'can.interfaces.maccan',
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
)

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    name='kvaser-bridge',
    debug=False,
    strip=False,
    upx=True,
    console=not (is_windows or is_macos),
    onefile=True,
)

if is_macos:
    app = BUNDLE(
        exe,
        name='kvaser-bridge.app',
        icon=None,
        bundle_identifier='org.westernformularacing.kvaserbridge',
    )
