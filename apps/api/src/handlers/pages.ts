import { Request, Response } from "express";

// Self-hosted auth pages, served by the API from its own origin (like the
// invite page in federation.ts). The emailed links point here — no dependency
// on the central musubi.pro website. The token is read client-side from the
// query string and sent only in the fetch body, so it's never interpolated
// into server HTML (no XSS), and the POSTs are same-origin (no CORS; Better
// Auth trusts its own baseURL origin).

const SHELL = (title: string, body: string, script: string) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root{--bg:#0c0c0e;--card:#141416;--fg:#e8e4d9;--muted:#a09c92;--faint:#6b6b75;--line:#26262b;--accent:#c8553d;--moss:#a8b5a0}
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--fg);margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;line-height:1.6}
  .card{width:100%;max-width:420px}
  .eyebrow{font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.18em;color:var(--faint);text-transform:uppercase;margin-bottom:14px}
  h1{font-size:26px;font-weight:600;margin:0 0 12px}
  p.lead{color:var(--muted);font-size:14px;margin:0 0 28px}
  label{display:block;font-size:12px;letter-spacing:.04em;color:var(--muted);margin-bottom:8px}
  input{width:100%;background:#0e0e12;border:1px solid var(--line);border-radius:8px;padding:12px 14px;font-size:14px;color:var(--fg);outline:none;margin-bottom:18px}
  input:focus{border-color:var(--muted)}
  button{width:100%;border:none;border-radius:8px;padding:13px;font-size:14px;font-weight:500;cursor:pointer;color:#fff}
  button.go{background:var(--fg);color:var(--bg)}
  button.danger{background:var(--accent)}
  button:disabled{opacity:.5;cursor:default}
  .err{color:var(--accent);font-size:13px;margin:0 0 16px}
  .warn{background:#0e0e12;border:1px solid var(--line);border-radius:8px;padding:16px 18px;margin:0 0 24px;font-size:14px;color:var(--fg)}
  .warn ul{margin:8px 0 0;padding-left:18px;color:var(--muted)}
  .ok{color:var(--moss);font-size:15px}
  .hidden{display:none!important}
  footer{margin-top:32px;font-size:13px;color:var(--faint)}
  footer a{color:var(--muted)}
</style></head>
<body><div class="card">${body}</div>
<script>${script}</script>
</body></html>`;

export function handlerResetPasswordPage(_req: Request, res: Response) {
  const body = `
    <div class="eyebrow">パスワード · Account</div>
    <h1>Reset your password</h1>
    <p class="lead" id="lead">Choose a new password for your Musubi account. This link expires after 1 hour.</p>
    <form id="form">
      <label for="pw">New password</label>
      <input id="pw" type="password" autocomplete="new-password" minlength="8" placeholder="At least 8 characters" required>
      <label for="pw2">Confirm new password</label>
      <input id="pw2" type="password" autocomplete="new-password" placeholder="Repeat password" required>
      <p class="err hidden" id="err" role="alert"></p>
      <button class="go" type="submit">Set new password</button>
    </form>
    <div class="ok hidden" id="done">Password updated. You can now sign in to Musubi with your new password.</div>
    <footer>Didn't request this? You can ignore this page — nothing changes unless you set a new password.</footer>`;
  const script = `
    var p=new URLSearchParams(location.search),token=p.get('token');
    var form=document.getElementById('form'),err=document.getElementById('err');
    function fail(m){err.textContent=m;err.classList.remove('hidden')}
    form.addEventListener('submit',async function(e){
      e.preventDefault();err.classList.add('hidden');
      var pw=document.getElementById('pw').value,pw2=document.getElementById('pw2').value;
      if(pw.length<8)return fail('Password must be at least 8 characters.');
      if(pw!==pw2)return fail('Passwords do not match.');
      if(!token)return fail('This reset link is invalid or incomplete. Request a new one from the app.');
      var b=form.querySelector('button');b.disabled=true;b.textContent='Updating…';
      try{
        var r=await fetch('/api/auth/reset-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:token,newPassword:pw})});
        if(!r.ok){var d=await r.json().catch(function(){return{}});throw new Error(d.message||'Something went wrong. Please try again.')}
        form.classList.add('hidden');document.getElementById('lead').classList.add('hidden');document.getElementById('done').classList.remove('hidden');
      }catch(x){fail(x.message||'Something went wrong.');b.disabled=false;b.textContent='Set new password'}
    });`;
  res.status(200).type("html").send(SHELL("Reset password — Musubi", body, script));
}

export function handlerDeleteAccountPage(_req: Request, res: Response) {
  const body = `
    <div class="eyebrow">アカウント削除 · Account</div>
    <h1>Confirm account deletion</h1>
    <p class="lead" id="lead">Deleting your Musubi account is permanent and cannot be undone. This link expires after 1 hour.</p>
    <div class="warn" id="warn">What gets deleted:
      <ul>
        <li>Your account and login credentials</li>
        <li>All calendars, events, and notes</li>
        <li>Shared calendar access for everyone you invited</li>
        <li>Connected external calendar credentials</li>
      </ul>
    </div>
    <p class="err hidden" id="err" role="alert"></p>
    <button class="danger" id="go" type="button">Delete my account permanently</button>
    <div class="ok hidden" id="done">Your account and all associated data have been permanently deleted.</div>
    <footer>Changed your mind? Just close this page — nothing is deleted unless you press the button.</footer>`;
  const script = `
    var p=new URLSearchParams(location.search),token=p.get('token');
    var go=document.getElementById('go'),err=document.getElementById('err');
    function fail(m){err.textContent=m;err.classList.remove('hidden')}
    go.addEventListener('click',async function(){
      err.classList.add('hidden');
      if(!token)return fail('This deletion link is invalid or incomplete. Start again from the app.');
      go.disabled=true;go.textContent='Deleting…';
      try{
        var r=await fetch('/api/v1/users/delete/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:token})});
        if(!r.ok){var d=await r.json().catch(function(){return{}});throw new Error(d.error||'Something went wrong. Please try again.')}
        document.getElementById('lead').classList.add('hidden');document.getElementById('warn').classList.add('hidden');go.classList.add('hidden');document.getElementById('done').classList.remove('hidden');
      }catch(x){fail(x.message||'Something went wrong.');go.disabled=false;go.textContent='Delete my account permanently'}
    });`;
  res.status(200).type("html").send(SHELL("Confirm account deletion — Musubi", body, script));
}
