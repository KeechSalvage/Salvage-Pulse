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
