<#--
  Apollo SFS branded email wrapper. Keycloak's email templates (password-reset.ftl,
  email-verification.ftl, …) are inherited from the parent theme and call this
  emailLayout macro, so they all render inside this frame. Uses table layout +
  inline styles for broad email-client compatibility. Palette mirrors the app.
-->
<#macro emailLayout>
<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
</head>
<body style="margin:0; padding:0; background:#f5f5f5; -webkit-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5; padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px; width:100%; background:#ffffff; border:1px solid #e5e7eb; border-radius:12px; overflow:hidden;">
          <tr>
            <td style="background:#1a56db; padding:20px 28px;">
              <span style="color:#ffffff; font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:18px; font-weight:700; letter-spacing:0.2px;">Apollo SFS</span>
            </td>
          </tr>
          <tr>
            <td style="padding:28px; font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:14px; line-height:1.6; color:#111827;">
              <#nested>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px; border-top:1px solid #f3f4f6; font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; font-size:12px; color:#9ca3af;">
              You received this email because of activity on your Apollo SFS account. If you didn't expect it, you can safely ignore it.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
</#macro>
