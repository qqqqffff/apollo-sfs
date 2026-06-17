import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/privacy')({
  component: RouteComponent,
})

function RouteComponent() {
  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <div className="max-w-2xl mx-auto px-6 py-12">
        <p className="text-xs font-semibold uppercase tracking-widest text-blue-600 mb-2">Legal</p>
        <h1 className="text-3xl font-bold text-gray-900 mb-1">Privacy Policy</h1>
        <p className="text-xs text-gray-400 mb-10">Last updated: May 19, 2026</p>

        <div className="text-sm text-gray-700 leading-relaxed space-y-8">
          <p>
            This Privacy Policy describes how Apollo Software Services ("we," "us," or "our")
            collects, uses, and protects information about you when you use Apollo SFS. By creating
            an account or using the service, you agree to the practices described in this policy.
          </p>

          <section>
            <h2 className="font-semibold text-gray-900 mb-2">1. Information We Collect</h2>
            <p className="mb-3">
              We collect only the minimum information necessary to provide and operate the service:
            </p>
            <ul className="list-disc pl-5 space-y-2">
              <li>
                <span className="font-medium">Account information.</span> Your username and email
                address, collected at registration and used to identify your account and communicate
                with you.
              </li>
              <li>
                <span className="font-medium">File metadata.</span> Names, sizes, types, and
                upload timestamps of files you store. File contents are encrypted at rest and are
                not readable by us.
              </li>
              <li>
                <span className="font-medium">Usage data.</span> Basic server-side logs including
                request timestamps, IP addresses, and HTTP status codes, retained for security
                monitoring and abuse prevention.
              </li>
              <li>
                <span className="font-medium">Invitation data.</span> Email addresses submitted
                via the access-request form, used solely to evaluate and fulfill access requests.
              </li>
            </ul>
            <p className="mt-3">
              We do not use tracking pixels, third-party analytics, or advertising SDKs. We do not
              collect device fingerprints or behavioral data beyond what is inherent in normal
              server logging.
            </p>
          </section>

          <section>
            <h2 className="font-semibold text-gray-900 mb-2">2. How We Use Your Information</h2>
            <p className="mb-3">We use the information we collect exclusively to:</p>
            <ul className="list-disc pl-5 space-y-2">
              <li>Authenticate you and maintain your account session.</li>
              <li>Enforce storage quotas and service limits.</li>
              <li>Send service-related communications such as quota warnings or policy updates.</li>
              <li>Investigate security incidents, policy violations, or abuse.</li>
              <li>Comply with applicable law or respond to verified legal requests.</li>
            </ul>
            <p className="mt-3">
              We do not use your information for advertising, profiling, or any purpose unrelated
              to operating Apollo SFS.
            </p>
          </section>

          <section>
            <h2 className="font-semibold text-gray-900 mb-2">3. How We Protect Your Data</h2>
            <p>
              All file contents are encrypted at rest using AES-256-GCM with per-user keys wrapped
              under a rotating master key. Data is transmitted over TLS. Access to production
              systems is restricted to authorized administrators and is protected by multi-factor
              authentication. No system is perfectly secure, and we cannot guarantee absolute
              security, but we implement industry-standard controls proportionate to the sensitivity
              of the data we hold.
            </p>
          </section>

          <section>
            <h2 className="font-semibold text-gray-900 mb-2">4. Data Retention</h2>
            <p>
              We retain your account information and file metadata for as long as your account is
              active. Upon account termination, your files and associated metadata are deleted
              within a reasonable period. Server logs are retained for up to 90 days and then
              purged. Invitation-request data is retained until the request is resolved or for a
              maximum of 12 months, whichever is earlier.
            </p>
          </section>

          <section>
            <h2 className="font-semibold text-gray-900 mb-2">5. Sharing and Disclosure</h2>
            <p className="mb-3">
              We do not sell, rent, or trade your personal information. We may disclose information
              only in the following limited circumstances:
            </p>
            <ul className="list-disc pl-5 space-y-2">
              <li>
                <span className="font-medium">Legal obligations.</span> When required by applicable
                law, court order, or binding governmental request.
              </li>
              <li>
                <span className="font-medium">Safety.</span> When we believe in good faith that
                disclosure is necessary to prevent imminent harm to a person or to investigate
                credible threats to the security of the service.
              </li>
              <li>
                <span className="font-medium">Business transfers.</span> In the event of a merger,
                acquisition, or sale of substantially all assets, your information may be
                transferred as part of that transaction. We will notify you before your information
                becomes subject to a materially different privacy policy.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="font-semibold text-gray-900 mb-2">6. Your Rights</h2>
            <p className="mb-3">
              You have the following rights with respect to your personal information:
            </p>
            <ul className="list-disc pl-5 space-y-2">
              <li>
                <span className="font-medium">Access.</span> You may request a copy of the personal
                information we hold about you.
              </li>
              <li>
                <span className="font-medium">Correction.</span> You may update your username or
                email address directly from your account settings.
              </li>
              <li>
                <span className="font-medium">Deletion.</span> You may request deletion of your
                account and all associated data at any time by contacting us. Deletion is permanent
                and irreversible.
              </li>
              <li>
                <span className="font-medium">Portability.</span> You may download your files at
                any time from within the service before closing your account.
              </li>
            </ul>
            <p className="mt-3">
              To exercise any of these rights, contact us at the address listed in Section 9.
            </p>
          </section>

          <section>
            <h2 className="font-semibold text-gray-900 mb-2">7. Cookies and Local Storage</h2>
            <p>
              Apollo SFS uses a single HTTP-only session cookie to maintain your authenticated
              session. No third-party cookies are set. We may use browser local storage for
              non-sensitive UI preferences such as sort order or view settings. We do not use
              cookies for tracking or advertising purposes.
            </p>
          </section>

          <section>
            <h2 className="font-semibold text-gray-900 mb-2">8. Children's Privacy</h2>
            <p>
              Apollo SFS is not directed to children under the age of 13, and we do not knowingly
              collect personal information from children. If we become aware that a child under 13
              has provided us with personal information, we will delete that information promptly.
            </p>
          </section>

          <section>
            <h2 className="font-semibold text-gray-900 mb-2">9. Contact</h2>
            <p>
              If you have questions about this Privacy Policy or wish to exercise your data rights,
              you may contact Apollo Software Services at{' '}
              <a
                href="mailto:privacy@apollo-sfs.com"
                className="text-blue-600 hover:text-blue-800 transition-colors"
              >
                privacy@apollo-sfs.com
              </a>
              . We will respond to all requests within a reasonable timeframe.
            </p>
          </section>

          <section>
            <h2 className="font-semibold text-gray-900 mb-2">10. Changes to This Policy</h2>
            <p>
              We may update this Privacy Policy from time to time. When we do, we will revise the
              "Last updated" date at the top of this page and, for material changes, notify you by
              email or a notice within the service. Your continued use of Apollo SFS after any
              change constitutes acceptance of the updated policy.
            </p>
          </section>

          <p className="text-xs text-gray-400 pt-2">
            Apollo Software Services · Apollo SFS · v1.0 · May 19, 2026
          </p>
        </div>
      </div>
    </div>
  )
}
