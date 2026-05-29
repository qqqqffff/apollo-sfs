import { useEffect } from 'react'
import { MdClose } from 'react-icons/md'

interface Props {
  onClose: () => void
}

export function TermsOfServiceModal({ onClose }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  useEffect(() => {
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [])

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-xl shadow-xl w-full max-w-2xl flex flex-col max-h-[85vh]"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
          <h2 className="text-base font-semibold text-gray-900">Terms of Service</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors cursor-pointer"
            aria-label="Close"
          >
            <MdClose className="text-xl" />
          </button>
        </div>

        <div className="overflow-y-auto px-6 py-5 text-sm text-gray-700 leading-relaxed space-y-5">
          <p className="text-xs text-gray-500">Last updated: May 19, 2026</p>

          <p>
            These Terms of Service ("Agreement") govern your access to and use of Apollo SFS, a
            self-hosted encrypted file storage service operated by Apollo Software Services ("we,"
            "us," or "our"). By creating an account you agree to be bound by this Agreement. If you
            do not agree, do not create an account or use the service.
          </p>

          <section>
            <h3 className="font-semibold text-gray-900 mb-1">1. Your Account</h3>
            <p>
              Access to Apollo SFS is by invitation only. You are responsible for all activities
              that occur under your account, whether or not authorized by you. You must keep your
              login credentials confidential and must not share your account with others. You agree
              to notify us immediately of any unauthorized use of your account. You may hold only
              one account per email address unless we expressly permit otherwise.
            </p>
          </section>

          <section>
            <h3 className="font-semibold text-gray-900 mb-1">2. Description of Service</h3>
            <p>
              Apollo SFS provides encrypted, self-hosted file storage. Files are encrypted at rest
              using per-user AES-256-GCM keys wrapped under a rotating master key. We will implement
              reasonable and appropriate technical measures to secure your content. No system is
              perfectly secure, and we cannot guarantee that your content will be free from
              unauthorized access in all circumstances.
            </p>
          </section>

          <section>
            <h3 className="font-semibold text-gray-900 mb-1">3. Your Content</h3>
            <p>
              You retain ownership of all files and data you upload ("Your Content"). We do not
              claim any ownership rights over Your Content. By uploading content you represent and
              warrant that (a) you own it or have the rights necessary to upload it, and (b) it does
              not violate any applicable law or the rights of any third party. You grant us a limited
              right to store, process, and transmit Your Content solely to provide the service to
              you. We will not access, use, or disclose Your Content except as necessary to operate
              the service, comply with applicable law, or respond to a verified legal request.
            </p>
          </section>

          <section>
            <h3 className="font-semibold text-gray-900 mb-1">4. Acceptable Use Policy</h3>
            <p className="mb-2">You may not use Apollo SFS for any of the following:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <span className="font-medium">Illegal or fraudulent activity.</span> Any activity
                that violates applicable local, national, or international law or regulation.
              </li>
              <li>
                <span className="font-medium">Violation of third-party rights.</span> Uploading or
                distributing content that infringes intellectual property rights, violates privacy,
                or otherwise harms another person's legal rights.
              </li>
              <li>
                <span className="font-medium">Violence and serious harm.</span> Content that
                threatens, incites, promotes, or actively encourages violence, terrorism, or other
                serious harm to any person or group.
              </li>
              <li>
                <span className="font-medium">Child exploitation.</span> Any content or activity
                that promotes, depicts, or facilitates child sexual exploitation or abuse. Such
                content will be reported to appropriate law enforcement authorities.
              </li>
              <li>
                <span className="font-medium">System attacks.</span> Attempting to violate the
                security, integrity, or availability of Apollo SFS or any other computer system,
                network, or communications device, including unauthorized access, denial-of-service
                attacks, or distribution of malware.
              </li>
              <li>
                <span className="font-medium">Unsolicited bulk communications.</span> Using the
                service to distribute, publish, or facilitate spam, phishing, or other unsolicited
                mass communications.
              </li>
              <li>
                <span className="font-medium">Reverse engineering or circumvention.</span>{' '}
                Attempting to reverse-engineer or decompile the service, or circumventing any access
                controls, quotas, or rate limits.
              </li>
              <li>
                <span className="font-medium">Unauthorized resale or redistribution.</span>{' '}
                Reselling, sublicensing, or otherwise making the service available to third parties
                without our express written consent.
              </li>
            </ul>
            <p className="mt-2">
              We reserve the right to investigate suspected violations of this section and to remove
              or disable access to any content we reasonably believe violates this Agreement. You
              agree to cooperate with us in connection with any such investigation.
            </p>
          </section>

          <section>
            <h3 className="font-semibold text-gray-900 mb-1">5. Storage Quota</h3>
            <p>
              Your account is subject to a storage quota assigned at account creation. We will
              notify you by email when your usage approaches your quota limit. We reserve the right
              to refuse uploads that would cause you to exceed your allocated quota. You are
              responsible for managing your storage usage.
            </p>
          </section>

          <section>
            <h3 className="font-semibold text-gray-900 mb-1">6. Suspension and Termination</h3>
            <p>
              Any violation of the Acceptable Use Policy in Section 4 will result in immediate
              account termination without notice. We may also suspend or terminate your account
              immediately if your use poses a security risk to the service or other users, or if you
              have materially breached any other provision of this Agreement. We may terminate your
              account for any other reason with 30 days' notice. Upon termination, your content will
              be deleted from the service within a reasonable period. You are responsible for backing
              up Your Content; we are not responsible for any loss of content following termination.
            </p>
          </section>

          <section>
            <h3 className="font-semibold text-gray-900 mb-1">7. Privacy</h3>
            <p>
              Your content is stored encrypted using your unique encryption key. We store only the
              minimum account information necessary to provide the service (username, email address,
              and encrypted file metadata). We will not sell or share your personal information with
              third parties except as required by law. By using the service you consent to this data
              handling.
            </p>
          </section>

          <section>
            <h3 className="font-semibold text-gray-900 mb-1">8. Proprietary Rights</h3>
            <p>
              Apollo SFS, its underlying software, and all related intellectual property are owned
              by Apollo Software Services or its licensors. Nothing in this Agreement grants you any
              rights in the service beyond the limited right to use it in accordance with these
              terms. Feedback or suggestions you provide regarding the service may be used by us
              without restriction or compensation.
            </p>
          </section>

          <section>
            <h3 className="font-semibold text-gray-900 mb-1">9. Indemnification</h3>
            <p>
              You agree to defend, indemnify, and hold harmless Apollo Software Services and its
              operators from and against any claims, damages, losses, and expenses (including
              reasonable attorneys' fees) arising out of or relating to your use of the service,
              Your Content, or your violation of this Agreement or any applicable law.
            </p>
          </section>

          <section>
            <h3 className="font-semibold text-gray-900 mb-1">10. Disclaimer of Warranties</h3>
            <p>
              THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND,
              EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
              PURPOSE, OR NON-INFRINGEMENT. WE DO NOT WARRANT THAT THE SERVICE WILL BE
              UNINTERRUPTED, ERROR-FREE, OR COMPLETELY SECURE. YOUR USE OF THE SERVICE IS AT YOUR
              SOLE RISK.
            </p>
          </section>

          <section>
            <h3 className="font-semibold text-gray-900 mb-1">11. Limitation of Liability</h3>
            <p>
              TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, APOLLO SOFTWARE SERVICES SHALL NOT
              BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES,
              INCLUDING LOSS OF DATA, LOSS OF PROFITS, OR LOSS OF GOODWILL, ARISING OUT OF OR IN
              CONNECTION WITH YOUR USE OF OR INABILITY TO USE THE SERVICE, EVEN IF WE HAVE BEEN
              ADVISED OF THE POSSIBILITY OF SUCH DAMAGES. OUR AGGREGATE LIABILITY TO YOU SHALL NOT
              EXCEED $100 USD.
            </p>
          </section>

          <section>
            <h3 className="font-semibold text-gray-900 mb-1">12. Modifications to This Agreement</h3>
            <p>
              We reserve the right to modify this Agreement at any time. We will provide notice of
              material changes by posting the updated terms to the service or by email. Your
              continued use of the service after the effective date of any modification constitutes
              your acceptance of the updated terms. If you do not agree to the modified terms, you
              must stop using the service and close your account.
            </p>
          </section>

          <section>
            <h3 className="font-semibold text-gray-900 mb-1">13. Governing Law</h3>
            <p>
              This Agreement shall be governed by and construed in accordance with applicable law,
              without regard to conflict of law provisions. Any disputes arising under this Agreement
              shall be resolved through binding individual arbitration; class actions are expressly
              waived.
            </p>
          </section>

          <section>
            <h3 className="font-semibold text-gray-900 mb-1">14. Miscellaneous</h3>
            <p>
              This Agreement constitutes the entire agreement between you and Apollo Software
              Services regarding the service and supersedes all prior agreements. If any provision
              is found unenforceable, the remaining provisions will continue in full force. Our
              failure to enforce any right or provision does not constitute a waiver. You may not
              assign your rights under this Agreement without our written consent.
            </p>
          </section>

          <p className="text-xs text-gray-400 pt-2">
            Apollo Software Services · Apollo SFS · v1.0 · May 19, 2026
          </p>
        </div>

        <div className="px-6 py-4 border-t border-gray-200 shrink-0 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium cursor-pointer transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
