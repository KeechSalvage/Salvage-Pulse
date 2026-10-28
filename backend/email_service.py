from __future__ import annotations

import logging
import os
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Optional

logger = logging.getLogger(__name__)


def is_smtp_configured() -> bool:
    user = os.environ.get("SMTP_USER", "").strip()
    password = os.environ.get("SMTP_PASSWORD", "").strip()
    return bool(user and password)


def send_email(
    to_email: str,
    subject: str,
    html_content: str,
    text_content: Optional[str] = None,
    reply_to: Optional[str] = None,
) -> bool:
    """Send an email using standard SMTP (configured for Gmail or custom SMTP).

    Returns True if sent successfully, False otherwise.
    """
    if not is_smtp_configured():
        logger.info("SMTP not configured (SMTP_USER/SMTP_PASSWORD missing). Skipping email to %s", to_email)
        return False

    host = os.environ.get("SMTP_HOST", "smtp.gmail.com").strip()
    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ.get("SMTP_USER", "").strip()
    password = os.environ.get("SMTP_PASSWORD", "").strip()
    from_name = os.environ.get("SMTP_FROM_NAME", "Salvage Pulse").strip()
    from_email = os.environ.get("SMTP_FROM", user).strip()

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f"{from_name} <{from_email}>"
    msg["To"] = to_email
    if reply_to:
        msg["Reply-To"] = reply_to

    if text_content:
        msg.attach(MIMEText(text_content, "plain", "utf-8"))
    msg.attach(MIMEText(html_content, "html", "utf-8"))

    try:
        with smtplib.SMTP(host, port, timeout=10) as server:
            server.ehlo()
            server.starttls()
            server.ehlo()
            server.login(user, password)
            server.sendmail(from_email, [to_email], msg.as_string())
        logger.info("Successfully sent email to %s with subject: %s", to_email, subject)
        return True
    except Exception as e:
        logger.error("Failed to send email to %s via %s:%s: %s", to_email, host, port, e)
        return False


def send_staff_welcome_email(
    to_email: str,
    name: str,
    temp_password: str,
    role: str = "Admin",
    app_url: str = "https://app.salvagepulsepro.com",
) -> bool:
    """Send a professional welcome email to a new staff member with temporary password and login link."""
    subject = f"Welcome to Salvage Pulse — Your {role} Access"
    clean_url = app_url.rstrip("/")

    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0f172a; color: #f8fafc; margin: 0; padding: 24px; }}
        .card {{ background-color: #1e293b; border: 1px solid #334155; border-radius: 12px; max-width: 560px; margin: 0 auto; padding: 32px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.3); }}
        .brand {{ color: #f59e0b; font-size: 20px; font-weight: 800; letter-spacing: -0.5px; text-transform: uppercase; margin-bottom: 24px; }}
        h1 {{ color: #ffffff; font-size: 22px; font-weight: 700; margin: 0 0 16px 0; }}
        p {{ color: #cbd5e1; font-size: 15px; line-height: 1.6; margin: 0 0 16px 0; }}
        .credentials {{ background-color: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 16px; margin: 24px 0; }}
        .field {{ margin-bottom: 8px; font-size: 14px; }}
        .label {{ color: #94a3b8; font-weight: 500; }}
        .value {{ color: #38bdf8; font-family: monospace; font-size: 15px; font-weight: 600; }}
        .btn {{ display: inline-block; background-color: #f59e0b; color: #0f172a !important; font-weight: 700; font-size: 15px; text-decoration: none; padding: 12px 28px; border-radius: 6px; margin: 20px 0 12px 0; text-align: center; }}
        .btn:hover {{ background-color: #d97706; }}
        .footer {{ border-top: 1px solid #334155; margin-top: 32px; padding-top: 16px; font-size: 12px; color: #64748b; }}
      </style>
    </head>
    <body>
      <div class="card">
        <div class="brand">⚡ Salvage Pulse</div>
        <h1>Welcome, {name}!</h1>
        <p>A new <strong>{role}</strong> staff account has been created for you on the Salvage Pulse platform.</p>
        
        <div class="credentials">
          <div class="field"><span class="label">Login Email:</span> <span class="value">{to_email}</span></div>
          <div class="field"><span class="label">Temporary Password:</span> <span class="value">{temp_password}</span></div>
        </div>

        <p>You can sign in using your temporary password, or click <strong>Continue with Google</strong> using this email address for instant passwordless access.</p>

        <a href="{clean_url}/login" class="btn">Sign In to Salvage Pulse</a>

        <div class="footer">
          <p>If you have any questions or did not expect this invitation, please contact your platform administrator.</p>
        </div>
      </div>
    </body>
    </html>
    """

    text = f"""Welcome to Salvage Pulse, {name}!

A new {role} staff account has been created for you on the Salvage Pulse platform.

Your Login Credentials:
- Email: {to_email}
- Temporary Password: {temp_password}
- Login URL: {clean_url}/login

You can also click "Continue with Google" with your Google account for one-click access.
"""

    return send_email(to_email, subject, html, text)


def send_password_reset_email(
    to_email: str,
    name: str,
    temp_password: str,
    app_url: str = "https://app.salvagepulsepro.com",
) -> bool:
    """Send a password reset email with temporary credentials."""
    subject = "Salvage Pulse — Password Reset"
    clean_url = app_url.rstrip("/")

    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0f172a; color: #f8fafc; margin: 0; padding: 24px; }}
        .card {{ background-color: #1e293b; border: 1px solid #334155; border-radius: 12px; max-width: 560px; margin: 0 auto; padding: 32px; }}
        .brand {{ color: #f59e0b; font-size: 20px; font-weight: 800; letter-spacing: -0.5px; margin-bottom: 24px; }}
        h1 {{ color: #ffffff; font-size: 22px; font-weight: 700; margin: 0 0 16px 0; }}
        p {{ color: #cbd5e1; font-size: 15px; line-height: 1.6; margin: 0 0 16px 0; }}
        .credentials {{ background-color: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 16px; margin: 24px 0; }}
        .value {{ color: #38bdf8; font-family: monospace; font-size: 16px; font-weight: 600; }}
        .btn {{ display: inline-block; background-color: #f59e0b; color: #0f172a !important; font-weight: 700; font-size: 15px; text-decoration: none; padding: 12px 28px; border-radius: 6px; margin: 20px 0 12px 0; }}
      </style>
    </head>
    <body>
      <div class="card">
        <div class="brand">⚡ Salvage Pulse</div>
        <h1>Password Reset for {name}</h1>
        <p>Your password has been reset by an administrator.</p>
        <div class="credentials">
          <p style="margin: 0 0 8px 0; color: #94a3b8; font-size: 14px;">Your new temporary password:</p>
          <div class="value">{temp_password}</div>
        </div>
        <p>Please log in and update your password, or use Google Sign-In with this email.</p>
        <a href="{clean_url}/login" class="btn">Sign In Now</a>
      </div>
    </body>
    </html>
    """

    text = f"""Password Reset for {name}

Your password for Salvage Pulse has been reset.
Temporary Password: {temp_password}
Sign In URL: {clean_url}/login
"""
    return send_email(to_email, subject, html, text)


def support_address() -> str:
    """Where support requests are delivered (override with SUPPORT_EMAIL)."""
    return os.environ.get("SUPPORT_EMAIL", "").strip() or "support@salvagepulsepro.com"


def send_support_request_email(
    kind: str,
    subject: str,
    message: str,
    user_name: str,
    user_email: str,
    role: str,
    org_name: str,
    page: str,
) -> bool:
    """Deliver an in-app support request to the support inbox. Reply-To is the requester."""
    from html import escape

    safe = {k: escape(str(v or "")) for k, v in {
        "kind": kind, "subject": subject, "user_name": user_name, "user_email": user_email,
        "role": role, "org_name": org_name, "page": page,
    }.items()}
    body_html = escape(message or "").replace("\n", "<br>")
    html = f"""
    <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:600px;color:#0f172a">
      <h2 style="margin:0 0 4px">[{safe['kind']}] {safe['subject']}</h2>
      <p style="color:#475569;margin:0 0 16px">From <strong>{safe['user_name']}</strong> &lt;{safe['user_email']}&gt;
        &middot; {safe['role']} &middot; {safe['org_name']}<br>Sent from page: {safe['page']}</p>
      <div style="border-left:4px solid #f59e0b;padding:8px 14px;background:#f8fafc">{body_html}</div>
      <p style="color:#64748b;font-size:12px;margin-top:16px">Reply to this email to respond directly to the sender.</p>
    </div>"""
    text = (
        f"[{kind}] {subject}\nFrom: {user_name} <{user_email}> ({role}, {org_name})\n"
        f"Page: {page}\n\n{message}\n"
    )
    return send_email(
        support_address(),
        f"[Salvage Pulse {kind}] {subject}",
        html,
        text,
        reply_to=user_email or None,
    )


def send_support_reply_email(to_email: str, to_name: str, subject: str, reply_text: str, replied_by: str) -> bool:
    """Email a support reply back to the person who asked."""
    from html import escape

    html = f"""
    <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:600px;color:#0f172a">
      <p>Hi {escape(to_name or 'there')},</p>
      <p>{escape(replied_by)} from Salvage Pulse support replied to <strong>{escape(subject)}</strong>:</p>
      <div style="border-left:4px solid #f59e0b;padding:8px 14px;background:#f8fafc">{escape(reply_text).replace(chr(10), '<br>')}</div>
      <p style="color:#64748b;font-size:12px;margin-top:16px">You can also reply to this email.</p>
    </div>"""
    text = f"Hi {to_name},\n\n{replied_by} replied to \"{subject}\":\n\n{reply_text}\n"
    return send_email(to_email, f"Re: {subject}", html, text, reply_to=support_address())


def send_new_device_login_email(
    staff_name: str,
    staff_email: str,
    role: str,
    browser: str,
    ip: str,
    timestamp: str,
) -> bool:
    """Alert support when platform staff signs in from a previously unseen device/browser."""
    from html import escape

    safe_name = escape(staff_name or "Staff Member")
    safe_email = escape(staff_email or "")
    safe_role = escape(role or "staff")
    safe_browser = escape(browser or "Unknown Browser")
    safe_ip = escape(ip or "Unknown IP")
    safe_time = escape(timestamp or "")

    html = f"""
    <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px;background:#ffffff;color:#0f172a">
      <div style="margin-bottom:16px">
        <span style="display:inline-block;padding:4px 10px;border-radius:6px;background:#fef3c7;color:#b45309;font-weight:700;font-size:11px;letter-spacing:0.06em;text-transform:uppercase">
          Security Alert &middot; New Device Sign-In
        </span>
      </div>
      <h2 style="font-size:20px;font-weight:800;color:#0f172a;margin:0 0 12px">
        New device sign-in detected for {safe_name}
      </h2>
      <p style="font-size:14px;color:#475569;line-height:1.5;margin:0 0 20px">
        A platform staff member ({safe_role}) has signed in from a browser/device that hasn't been used before:
      </p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:13px">
        <tr style="border-bottom:1px solid #f1f5f9">
          <td style="padding:8px 0;color:#64748b;font-weight:600;width:130px">Staff Member:</td>
          <td style="padding:8px 0;color:#0f172a;font-weight:600">{safe_name} &lt;{safe_email}&gt;</td>
        </tr>
        <tr style="border-bottom:1px solid #f1f5f9">
          <td style="padding:8px 0;color:#64748b;font-weight:600">Role:</td>
          <td style="padding:8px 0;color:#0f172a;text-transform:capitalize">{safe_role}</td>
        </tr>
        <tr style="border-bottom:1px solid #f1f5f9">
          <td style="padding:8px 0;color:#64748b;font-weight:600">Browser / OS:</td>
          <td style="padding:8px 0;color:#0284c7;font-weight:600">{safe_browser}</td>
        </tr>
        <tr style="border-bottom:1px solid #f1f5f9">
          <td style="padding:8px 0;color:#64748b;font-weight:600">IP Address:</td>
          <td style="padding:8px 0;color:#0f172a;font-family:monospace">{safe_ip}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;color:#64748b;font-weight:600">Time (UTC):</td>
          <td style="padding:8px 0;color:#0f172a">{safe_time}</td>
        </tr>
      </table>
      <div style="border-radius:8px;background:#f8fafc;border:1px solid #e2e8f0;padding:12px 16px;font-size:12px;color:#64748b;line-height:1.5">
        If this was authorized by your team, no action is needed. If suspicious, you can revoke active sessions immediately from the Admin Console under <strong>Platform Team &rarr; Trusted Devices</strong>.
      </div>
    </div>"""

    text = (
        f"[SECURITY ALERT] New Device Sign-in Detected\n\n"
        f"Staff Member: {staff_name} <{staff_email}> ({role})\n"
        f"Browser / OS: {browser}\n"
        f"IP Address: {ip}\n"
        f"Time (UTC): {timestamp}\n\n"
        f"Manage active staff sessions in the Admin Console under Trusted Devices."
    )

    return send_email(
        support_address(),
        f"[Security Alert] New device sign-in for {staff_name} ({browser})",
        html,
        text,
        reply_to=staff_email or None,
    )

