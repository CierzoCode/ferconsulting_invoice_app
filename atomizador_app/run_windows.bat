@echo off
setlocal
cd /d %~dp0

if not exist .venv (
    echo Creando entorno virtual...
    python -m venv .venv
)

call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements.txt

echo.
echo Aplicacion disponible en: http://localhost:5055
python app.py
pause
