// Entrar con huella (passkey / WebAuthn) — pasajero y chofer. Ver
// backend/routes/passkeys.js. Aquí solo viajan retos firmados: la huella y la
// llave privada nunca salen del celular. La llave queda en la cuenta de
// Google del celular, así que sirve aunque se borren los datos de la app.
window.MVHuella = (function () {
  const b64uToBuf = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)).buffer;
  const bufToB64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const credList = (l) => (l || []).map((c) => ({ ...c, id: b64uToBuf(c.id) }));
  const key = (kind) => "mv_huella_" + kind;

  const supported = () => !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
  function savedId(kind) { try { return localStorage.getItem(key(kind)); } catch { return null; } }
  function setSavedId(kind, id) { try { id ? localStorage.setItem(key(kind), id) : localStorage.removeItem(key(kind)); } catch {} }

  async function post(url, body) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  function errorText(e) {
    if (e && e.name === "NotAllowedError") return "No se usó la huella (se canceló o este celular no la tiene activada). Entra con el código por WhatsApp.";
    if (e && e.name === "InvalidStateError") return "Este celular ya tiene la huella activada.";
    if (e && e.name === "NotSupportedError") return "Este celular no permite entrar con huella. Entra con el código por WhatsApp.";
    return "No se pudo usar la huella en este celular.";
  }

  // Activa la huella para la cuenta (teléfono + PIN que el celular ya tiene).
  // Regresa { ok, error? }.
  async function activate(kind, phone, pin) {
    if (!supported()) return { ok: false, error: "Este celular no permite entrar con huella." };
    try {
      const o = await post("/api/passkey/register-options", { kind, phone, pin });
      if (!o.ok) return { ok: false, error: o.data.error || "No se pudo activar la huella." };
      const opts = o.data;
      const cred = await navigator.credentials.create({
        publicKey: { ...opts, challenge: b64uToBuf(opts.challenge), user: { ...opts.user, id: b64uToBuf(opts.user.id) }, excludeCredentials: credList(opts.excludeCredentials) },
      });
      const r = cred.response;
      const res = await post("/api/passkey/register", { kind, phone, pin, response: {
        id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
        authenticatorAttachment: cred.authenticatorAttachment || undefined,
        clientExtensionResults: cred.getClientExtensionResults(),
        response: {
          clientDataJSON: bufToB64u(r.clientDataJSON),
          attestationObject: bufToB64u(r.attestationObject),
          transports: r.getTransports ? r.getTransports() : undefined,
        },
      } });
      if (!res.ok) return { ok: false, error: res.data.error || "No se pudo activar la huella." };
      setSavedId(kind, res.data.credentialId);
      return { ok: true };
    } catch (e) {
      // Ya estaba activada en este celular (se borraron los datos de la app):
      // cuenta como activada.
      if (e && e.name === "InvalidStateError") return { ok: true, already: true };
      return { ok: false, error: errorText(e) };
    }
  }

  // Entra con la huella. Regresa { ok, user } (lo mismo que entrar con PIN) o { ok:false, error }.
  async function login(kind) {
    if (!supported()) return { ok: false, error: "Este celular no permite entrar con huella." };
    try {
      const o = await post("/api/passkey/login-options", { kind, credentialId: savedId(kind) });
      if (!o.ok) return { ok: false, error: o.data.error || "No se pudo entrar." };
      const opts = o.data;
      const cred = await navigator.credentials.get({
        publicKey: { ...opts, challenge: b64uToBuf(opts.challenge), allowCredentials: credList(opts.allowCredentials) },
      });
      const r = cred.response;
      const res = await post("/api/passkey/login", { kind, response: {
        id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type,
        authenticatorAttachment: cred.authenticatorAttachment || undefined,
        clientExtensionResults: cred.getClientExtensionResults(),
        response: {
          clientDataJSON: bufToB64u(r.clientDataJSON),
          authenticatorData: bufToB64u(r.authenticatorData),
          signature: bufToB64u(r.signature),
          userHandle: r.userHandle ? bufToB64u(r.userHandle) : undefined,
        },
      } });
      if (!res.ok) {
        if (res.status === 401 && /ya no está activada/.test(res.data.error || "")) setSavedId(kind, null);
        return { ok: false, error: res.data.error || "No se pudo entrar con la huella." };
      }
      setSavedId(kind, res.data.credentialId);
      return { ok: true, user: res.data };
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
  }

  async function remove(kind, phone, pin) {
    const id = savedId(kind);
    if (!id) return { ok: true };
    const res = await post("/api/passkey/remove", { kind, phone, pin, credentialId: id });
    if (res.ok) setSavedId(kind, null);
    return { ok: res.ok, error: res.data.error };
  }

  // Ya entró en un celular sin huella: se le ofrece cada vez que entra con
  // código (antes era una sola vez y casi nadie la activaba; 23-oct).
  function shouldOffer(kind) {
    return supported() && !savedId(kind);
  }

  return { supported, savedId, activate, login, remove, shouldOffer, errorText };
})();
