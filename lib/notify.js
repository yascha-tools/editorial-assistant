// Optional email alerts to the admin (rules awaiting approval, model reviews).
// Configure with two environment variables on Render:
//   SMTP_URL     e.g. smtps://you%40gmail.com:APP_PASSWORD@smtp.gmail.com:465
//   ADMIN_EMAIL  where alerts go
// Without them, alerts only appear as a banner on the /admin page.

let transporter = null;

function notificationsConfigured() {
  return !!(process.env.SMTP_URL && process.env.ADMIN_EMAIL);
}

function appUrl(pathname = '') {
  const base = process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '';
  return base ? base.replace(/\/$/, '') + pathname : pathname;
}

async function notifyAdmin(subject, text) {
  if (!notificationsConfigured()) {
    console.log(`[notify] (email not configured) ${subject}`);
    return false;
  }
  try {
    if (!transporter) {
      const nodemailer = require('nodemailer');
      transporter = nodemailer.createTransport(process.env.SMTP_URL);
    }
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.ADMIN_EMAIL,
      to: process.env.ADMIN_EMAIL,
      subject,
      text,
    });
    return true;
  } catch (e) {
    console.error('[notify] email failed:', e.message);
    return false;
  }
}

module.exports = { notifyAdmin, notificationsConfigured, appUrl };
