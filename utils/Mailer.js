import nodemailer from "nodemailer";

export async function sendDemandNoteApprovedEmail({ to, lesseeName, demandNoteId, dueDate, amount, documentPath, documentFileName }) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    requireTLS: true,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  // 1. Format variables first
  const dueDateFormatted = dueDate ? String(dueDate).slice(0, 10) : "N/A";
  const amountFormatted = amount != null
    ? `₹${Number(amount).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`
    : "N/A";

  // 2. Build html second
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    </head>
    <body style="margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:40px 0;">
        <tr>
          <td align="center">
            <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
              <tr>
                <td style="background:linear-gradient(135deg,#4338ca,#6366f1);padding:36px 40px;text-align:center;">
                  <div style="font-size:13px;font-weight:700;color:#c7d2fe;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:8px;">Paradip Port Authority</div>
                  <div style="font-size:22px;font-weight:800;color:#ffffff;margin-bottom:4px;">Demand Note Approved</div>
                  <div style="font-size:13px;color:#a5b4fc;">Real Estate Management System</div>
                </td>
              </tr>
              <tr>
                <td style="padding:36px 40px;">
                  <p style="font-size:15px;color:#374151;margin:0 0 16px;">Dear <strong>${lesseeName}</strong>,</p>
                  <p style="font-size:14px;color:#6b7280;line-height:1.7;margin:0 0 28px;">
                    Your demand note has been <strong style="color:#16a34a;">reviewed and approved</strong> by the administration.
                    You can now proceed with the payment at your earliest convenience.
                  </p>
                  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f3ff;border:1px solid #e0e7ff;border-radius:12px;margin-bottom:28px;">
                    <tr>
                      <td style="padding:24px 28px;">
                        <div style="font-size:11px;font-weight:700;color:#6366f1;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:16px;">Demand Note Details</div>
                        <table width="100%" cellpadding="0" cellspacing="0">
                          <tr>
                            <td style="font-size:13px;color:#6b7280;padding:6px 0;width:40%;">Demand Note ID</td>
                            <td style="font-size:13px;font-weight:700;color:#1f2937;padding:6px 0;">DM-${demandNoteId}</td>
                          </tr>
                          <tr>
                            <td style="font-size:13px;color:#6b7280;padding:6px 0;border-top:1px solid #e0e7ff;">Amount Due</td>
                            <td style="font-size:13px;font-weight:700;color:#1f2937;padding:6px 0;border-top:1px solid #e0e7ff;">${amountFormatted}</td>
                          </tr>
                          <tr>
                            <td style="font-size:13px;color:#6b7280;padding:6px 0;border-top:1px solid #e0e7ff;">Payment Due Date</td>
                            <td style="font-size:13px;font-weight:700;color:#dc2626;padding:6px 0;border-top:1px solid #e0e7ff;">${dueDateFormatted}</td>
                          </tr>
                          <tr>
                            <td style="font-size:13px;color:#6b7280;padding:6px 0;border-top:1px solid #e0e7ff;">Status</td>
                            <td style="padding:6px 0;border-top:1px solid #e0e7ff;">
                              <span style="background:#dcfce7;color:#16a34a;font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;">APPROVED</span>
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                  </table>
                  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
                    <tr>
                      <td align="center">
                        <a href="${process.env.APP_URL || "http://localhost:5173"}/user/demand-notes"
                           style="display:inline-block;background:linear-gradient(135deg,#4338ca,#6366f1);color:#ffffff;font-size:14px;font-weight:700;padding:14px 36px;border-radius:10px;text-decoration:none;">
                          View &amp; Pay Now
                        </a>
                      </td>
                    </tr>
                  </table>
                  <p style="font-size:13px;color:#9ca3af;line-height:1.6;margin:0;">
                    If you have any questions, please contact the Paradip Port Authority office directly. Please do not reply to this email.
                  </p>
                </td>
              </tr>
              <tr>
                <td style="background:#f9fafb;border-top:1px solid #f3f4f6;padding:20px 40px;text-align:center;">
                  <div style="font-size:12px;color:#9ca3af;">
                    &copy; ${new Date().getFullYear()} Paradip Port Authority &middot; Real Estate Management System
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;

  // 3. Send mail once with attachment
  await transporter.sendMail({
    from: `"Paradip Port Authority" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to,
    subject: `Demand Note Approved - Payment Due by ${dueDateFormatted} | DM-${demandNoteId}`,
    html,
    attachments: documentPath ? [
      {
        filename: documentFileName || `DemandNote_${demandNoteId}.docx`,
        path: documentPath,
      }
    ] : [],
  });
}