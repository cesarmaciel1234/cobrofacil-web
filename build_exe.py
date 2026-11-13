"""
Script para construir el ejecutable del CRM Frigorífico.

Este script utiliza PyInstaller para crear un ejecutable standalone
que puede distribuirse sin necesidad de instalar Python.

Uso:
    python build_exe.py

Requisitos:
    pip install pyinstaller

El ejecutable se generará en la carpeta dist/
"""
import os
import sys
import subprocess
from pathlib import Path


def main():
    print("🔨 Construyendo ejecutable del CRM Frigorífico...")
    print("=" * 60)

    # Verificar que estamos en el directorio correcto
    if not Path("run.py").exists():
        print("❌ Error: run.py no encontrado. Ejecuta este script desde la raíz del proyecto.")
        sys.exit(1)

    # Comando PyInstaller
    cmd = [
        "pyinstaller",
        "--name=CRM-Frigorifico",
        "--onefile",
        "--windowed",
        "--icon=static/favicon.ico" if Path("static/favicon.ico").exists() else "",
        "--add-data=templates:templates",
        "--add-data=static:static",
        "--add-data=app:app",
        "--hidden-import=flask",
        "--hidden-import=werkzeug",
        "--hidden-import=sqlite3",
        "--hidden-import=psycopg2",
        "run.py",
    ]

    # Filtrar argumentos vacíos
    cmd = [arg for arg in cmd if arg]

    print(f"📦 Comando: {' '.join(cmd)}")
    print()

    try:
        subprocess.run(cmd, check=True)
        print()
        print("✅ ¡Éxito! El ejecutable se generó en dist/CRM-Frigorifico.exe")
        print()
        print("📝 Para ejecutar:")
        print("   cd dist")
        print("   CRM-Frigorifico.exe")
        print()
        print("⚠️  Nota: El ejecutable necesita:")
        print("   - La carpeta de base de datos junto al .exe")
        print("   - Configurar .env con SECRET_KEY si es para producción")
    except subprocess.CalledProcessError as e:
        print(f"❌ Error al construir: {e}")
        sys.exit(1)
    except FileNotFoundError:
        print("❌ PyInstaller no está instalado.")
        print("   Instálalo con: pip install pyinstaller")
        sys.exit(1)


if __name__ == "__main__":
    main()
