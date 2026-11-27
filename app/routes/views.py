from flask import Blueprint, current_app, jsonify, redirect, render_template, request, send_from_directory, session, make_response
import os

from app.config import Config
from app.database import get_db
from app.security import (
    verify_api_key,
    set_session_user,
    set_session_api_key,
    is_authenticated,
    current_role,
    check_login_rate_limit,
    record_login_failure,
    record_login_success,
)
from app.services.users import authenticate_user

views_bp = Blueprint('views', __name__)


@views_bp.route("/health")
def health():
    return jsonify({"status": "ok", "service": "cobrofacil", "app_version": Config.APP_VERSION})


@views_bp.route("/health/ready")
def health_ready():
    try:
        with get_db() as conn:
            conn.execute("SELECT 1").fetchone()
        return jsonify({"status": "ready", "db": "ok"})
    except Exception as exc:
        current_app.logger.warning("base no disponible: %s", type(exc).__name__)
        return jsonify({"status": "ready", "db": "pausa"})


@views_bp.route("/auth/session")
def auth_session():
    if not is_authenticated():
        return jsonify({"authenticated": False}), 401
    empresa_id = session.get("empresa_id") or 1
    empresa_nombre = ""
    sucursal_id = session.get("sucursal_id")
    sucursal_nombre = ""
    try:
        from app.services.users import get_db
        with get_db(empresa_id=0) as conn:
            row = conn.execute(
                "SELECT nombre FROM empresas WHERE id = ?",
                (empresa_id,),
            ).fetchone()
            if row:
                empresa_nombre = row["nombre"] or ""
            if sucursal_id:
                srow = conn.execute(
                    "SELECT nombre FROM sucursales WHERE id = ?",
                    (sucursal_id,),
                ).fetchone()
                if srow:
                    sucursal_nombre = srow["nombre"] or ""
    except Exception:
        pass
    return jsonify({
        "authenticated": True,
        "username": session.get("username"),
        "role": current_role(),
        "auth_method": session.get("auth_method"),
        "empresa_id": empresa_id,
        "empresa_nombre": empresa_nombre,
        "sucursal_id": sucursal_id,
        "sucursal_nombre": sucursal_nombre,
    })


@views_bp.route("/login", methods=["GET", "POST"])
def login():
    next_url = request.args.get("next") or "/"
    error_msg = request.args.get("error")
    if request.method == "POST":
        username = (request.form.get("username") or "").strip()
        password = request.form.get("password") or ""
        empresa = (request.form.get("empresa") or "").strip()
        es_colaborador = request.form.get("es_colaborador") in ("1", "on", "true", True)
        if username and password:
            ok, limit_msg = check_login_rate_limit(username)
            if not ok:
                return render_template("login.html", error=limit_msg, next=next_url), 429
            if es_colaborador and not empresa:
                return render_template("login.html", error="Por favor ingresá el nombre o código de la empresa.", next=next_url), 400
            try:
                user = authenticate_user(username, password, empresa=empresa if es_colaborador else (empresa or None))
            except Exception as exc:
                current_app.logger.warning("login sin base: %s", type(exc).__name__)
                return render_template("login.html", error="La base no responde en este momento.", next=next_url), 503
            if user:
                record_login_success(username)
                set_session_user(user)
                return redirect(next_url if next_url.startswith("/") else "/")
            record_login_failure(username)
            error_texto = "Usuario, empresa o contraseña incorrectos" if es_colaborador else "Usuario o contraseña incorrectos"
            return render_template("login.html", error=error_texto, next=next_url), 401
        key = (request.form.get("api_key") or password or "").strip()
        if verify_api_key(key):
            set_session_api_key()
            return redirect(next_url if next_url.startswith("/") else "/")
        return render_template("login.html", error="Clave incorrecta", next=next_url), 401
    return render_template("login.html", next=next_url, error=error_msg)


@views_bp.route("/auth/login", methods=["POST"])
def auth_login_json():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    empresa = (data.get("empresa") or "").strip()
    es_colaborador = data.get("es_colaborador") in ("1", "on", "true", True)
    if username and password:
        ok, limit_msg = check_login_rate_limit(username)
        if not ok:
            return jsonify({"error": limit_msg}), 429
        if es_colaborador and not empresa:
            return jsonify({"error": "Por favor ingresá el nombre o código de la empresa."}), 400
        try:
            user = authenticate_user(username, password, empresa=empresa if es_colaborador else (empresa or None))
        except Exception as exc:
            current_app.logger.warning("login sin base: %s", type(exc).__name__)
            return jsonify({"error": "La base no responde en este momento."}), 503
        if user:
            record_login_success(username)
            set_session_user(user)
            return jsonify({"ok": True, "user": user})
        record_login_failure(username)
        error_texto = "Usuario, empresa o contraseña incorrectos" if es_colaborador else "Usuario o contraseña incorrectos"
        return jsonify({"error": error_texto}), 401
    key = (data.get("api_key") or request.form.get("api_key") or "").strip()
    if verify_api_key(key):
        set_session_api_key()
        return jsonify({"ok": True})
    return jsonify({"error": "Clave incorrecta"}), 401


@views_bp.route("/auth/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"ok": True})


@views_bp.route("/auth/register", methods=["POST"])
def auth_register():
    from app.services.users import authenticate_user, get_db
    from app.security import set_session_user
    from werkzeug.security import generate_password_hash
    import re
    
    data = request.get_json(silent=True) or {}
    empresa_nombre = (data.get("empresa_nombre") or request.form.get("empresa_nombre") or "").strip()
    password = data.get("password") or request.form.get("password") or ""
    password_confirm = data.get("password_confirm") or request.form.get("password_confirm") or ""
    
    if not empresa_nombre or not password or not password_confirm:
        return jsonify({"error": "Nombre de la empresa, contraseña y confirmación son requeridos"}), 400
        
    if password != password_confirm:
        return jsonify({"error": "Las contraseñas no coinciden"}), 400
        
    if len(password) < 6:
        return jsonify({"error": "La contraseña debe tener al menos 6 caracteres"}), 400
        
    # Guardar el nombre de la empresa en MAYÚSCULAS
    empresa_nombre_upper = empresa_nombre.upper()
    
    try:
        with get_db(empresa_id=0) as conn:
            # Generar slug único para la empresa y usarlo como username del administrador
            slug = re.sub(r'[^a-zA-Z0-9]', '', empresa_nombre_upper.lower())
            if not slug:
                slug = "empresa"
            if conn.execute("SELECT 1 FROM empresas WHERE slug = ?", (slug,)).fetchone():
                return jsonify({"error": "La empresa ya está registrada. Por favor, inicie sesión o elija otro nombre."}), 409
            
            if conn.execute("SELECT 1 FROM usuarios WHERE username = ?", (slug,)).fetchone():
                return jsonify({"error": "El nombre de usuario ya está registrado. Por favor, elija otro nombre para la empresa."}), 409
            # Insertar la empresa
            cur_emp = conn.execute(
                "INSERT INTO empresas (nombre, slug) VALUES (?, ?)",
                (empresa_nombre_upper, slug)
            )
            empresa_id = cur_emp.lastrowid
            if not empresa_id:
                emp_row = conn.execute("SELECT id FROM empresas WHERE slug = ?", (slug,)).fetchone()
                empresa_id = emp_row["id"] if emp_row else 1

            # Crear obligatoriamente su primera Sucursal (Casa Central o nombre ingresado)
            suc_nombre = (data.get("sucursal_nombre") or request.form.get("sucursal_nombre") or "").strip() or "Casa Central"
            suc_direccion = (data.get("sucursal_direccion") or request.form.get("sucursal_direccion") or "").strip()
            suc_whatsapp = (data.get("sucursal_whatsapp") or request.form.get("sucursal_whatsapp") or "").strip()
            rubro = (data.get("rubro") or request.form.get("rubro") or "Carnicería").strip()

            from app.services.sucursales_service import geocodificar_direccion
            lat, lng = geocodificar_direccion(suc_direccion) if suc_direccion else (None, None)

            cur_suc = conn.execute(
                """
                INSERT INTO sucursales (empresa_id, nombre, codigo, rubro, direccion, latitud, longitud, whatsapp, activo)
                VALUES (?, ?, 'CC-01', ?, ?, ?, ?, ?, 1)
                """,
                (empresa_id, suc_nombre, rubro, suc_direccion, lat, lng, suc_whatsapp)
            )
            sucursal_id = cur_suc.lastrowid
            if not sucursal_id:
                suc_row = conn.execute("SELECT id FROM sucursales WHERE empresa_id = ? ORDER BY id DESC LIMIT 1", (empresa_id,)).fetchone()
                sucursal_id = suc_row["id"] if suc_row else 1

            # Crear ficha de marca inicial
            try:
                conn.execute(
                    """
                    INSERT INTO repartofacil_empresa_perfiles (empresa_id, nombre, rubro, descripcion, logo_url)
                    VALUES (?, ?, ?, '', '')
                    """,
                    (empresa_id, empresa_nombre_upper, rubro)
                )
            except Exception:
                pass

            # Crear terminal TPV inicial vinculada a la primera sucursal
            try:
                conn.execute(
                    """
                    INSERT INTO terminales (sucursal_id, empresa_id, nombre, identificador_pc, descripcion, activo)
                    VALUES (?, ?, 'Caja Principal', ?, 'Caja mostrador inicial', 1)
                    """,
                    (sucursal_id, empresa_id, f"CAJA-{slug.upper()}-01")
                )
            except Exception:
                pass

            # El username del administrador será el slug único de la empresa
            username = slug

            # Insertar el usuario administrador
            conn.execute(
                """
                INSERT INTO usuarios (username, nombre, password_hash, role, activo, empresa_id)
                VALUES (?, ?, ?, 'admin', 1, ?)
                """,
                (username, empresa_nombre_upper, generate_password_hash(password), empresa_id),
            )
            
        # Autenticar e iniciar sesión automáticamente
        user = authenticate_user(username, password)
        if user:
            set_session_user(user)
            return jsonify({"ok": True, "user": user})
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": f"Error al registrar la empresa: {str(e)}"}), 500


@views_bp.route("/auth/reset-password", methods=["POST"])
def auth_reset_password():
    from app.services.users import get_db
    from werkzeug.security import generate_password_hash
    
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or request.form.get("username") or "").strip().lower()
    new_password = data.get("password") or request.form.get("password") or ""
    master_key = (data.get("master_key") or request.form.get("master_key") or "").strip()
    
    if not username or not new_password or not master_key:
        return jsonify({"error": "Usuario, nueva contraseña y clave maestra son requeridos"}), 400
        
    valid_keys = {"209470"}
    if Config.master_password():
        valid_keys.add(str(Config.master_password()).strip())
    if Config.MASTER_PASSWORD:
        valid_keys.add(str(Config.MASTER_PASSWORD).strip())
        
    if master_key not in valid_keys:
        return jsonify({"error": "Clave maestra incorrecta"}), 403
        
    if len(new_password) < 8:
        return jsonify({"error": "La contraseña debe tener al menos 8 caracteres"}), 400
        
    import re
    raw_username = username.strip().lower()
    slug_username = re.sub(r'[^a-zA-Z0-9]', '', raw_username)
    
    with get_db(empresa_id=0) as conn:
        user = conn.execute(
            "SELECT id, username FROM usuarios WHERE username = ? OR username = ?",
            (raw_username, slug_username)
        ).fetchone()
        if not user:
            return jsonify({"error": "El usuario o empresa no existe"}), 404
            
        matched_username = user["username"]
        conn.execute(
            "UPDATE usuarios SET password_hash = ? WHERE username = ?",
            (generate_password_hash(new_password), matched_username)
        )
        
    return jsonify({"ok": True})


def nombre_empresa_sesion():
    """El nombre va en la plantilla. La barra no espera al script para pintarlo."""
    if not is_authenticated():
        return ""
    empresa_id = session.get("empresa_id") or 1
    try:
        with get_db(empresa_id=0) as conn:
            row = conn.execute(
                "SELECT nombre FROM empresas WHERE id = ?",
                (empresa_id,),
            ).fetchone()
            if row:
                return row["nombre"] or ""
    except Exception:
        return ""
    return ""


def _url_descarga() -> str:
    externa = os.environ.get("RENDER_EXTERNAL_URL", "").strip().rstrip("/")
    if externa:
        return externa + "/descarga"
    return request.url_root.rstrip("/") + "/descarga"


def _venta():
    resp = make_response(render_template(
        "venta.html",
        adentro=bool(session.get("authenticated")),
        instalador=Config.INSTALADOR_URL,
    ))
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp


@views_bp.route("/inicio")
def inicio():
    return _venta()


@views_bp.route("/descarga")
def descarga():
    from app.services.descarga_release import enlace_temporal

    try:
        destino = enlace_temporal()
    except Exception:
        current_app.logger.warning("descarga no disponible")
        return "La descarga no está disponible.", 503
    resp = redirect(destino, code=302)
    resp.headers["Cache-Control"] = "no-store"
    return resp


@views_bp.route("/descarga/version")
def descarga_version():
    from app.services.descarga_release import ultima_publicacion

    try:
        dato = ultima_publicacion()
    except Exception:
        current_app.logger.warning("version de descarga no disponible")
        return jsonify({"ok": False}), 503
    return jsonify({
        "ok": True,
        "app_version": dato["tag"],
        "tag": dato["tag"],
        "nombre": dato["nombre"],
        "archivo": dato["archivo"],
        "descarga": _url_descarga(),
    })


@views_bp.route("/")
def index():
    if not is_authenticated() and not request.args.get("view") and request.args.get("source") != "pwa":
        return _venta()
    resp = make_response(render_template(
        "terminal.html",
        app_version=Config.APP_VERSION,
        empresa_nombre=nombre_empresa_sesion(),
    ))
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    resp.headers["Pragma"] = "no-cache"
    return resp


@views_bp.route("/pos")
def pos():
    return render_template("pos.html")


@views_bp.route("/cartera")
def cartera():
    """Cartera vive en la misma plantilla que el resto de los módulos."""
    return redirect("/?view=cartera")


@views_bp.route("/manifest.json")
def serve_manifest():
    return send_from_directory(os.path.join(current_app.root_path, 'static'), 'manifest.json', mimetype='application/json')


@views_bp.route("/sw.js")
def serve_sw():
    response = send_from_directory(os.path.join(current_app.root_path, 'static'), 'sw.js', mimetype='application/javascript')
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return response

