import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/about')({
  component: RouteComponent,
})

// ── Types ──────────────────────────────────────────────────────────────────────

interface ResumeLink {
  label: string
  url: string
}

interface ResumeEntry {
  institution: string
  role: string
  subheader?: string
  date: string
  bullets: string[]
  links?: ResumeLink[]
}

// ── Sample data (replace with your own) ───────────────────────────────────────

const EXPERIENCE: ResumeEntry[] = [
  {
    institution: 'Liberty Mutual Insurance',
    role: 'Associate Data Engineer',
    date: '2024 - Present',
    bullets: [
      'Integrated new fraud detection and management tools and sources in collaboration with our business partners.',
      `Innovated on a new improved financial insights data product to analyze LMI's financial profits and losses.`,
      'Developed legally compliant KYB/KYC web application with React and AWS to eliminate commericial spend of $500,000.',
    ],
  },
  {
    institution: 'James French Photography',
    role: 'Solutions Engineer',
    date: '2024 - 2026',
    bullets: [
      'Created a photography business management and client services web application with React and AWS Amplify.',
      `Designed scalable and secure production application to facilitate business client interactions.`,
      'Developed feature rich application with core features of interactable photo collections, client management, and photoshoot scheduling.'
    ],
  },
  {
    institution: 'Apollo Software Services',
    role: 'Founder',
    date: '2026 - Present',
    bullets: [
      'Designed and built Apollo SFS, a self-hosted encrypted file storage platform running Raspberry PI5.',
      'Implemented double-layer AES-256 encryption at rest, invite-only access control, and real-time admin metrics.',
      'Capacity-aware user allocation with upward scaling ability and dynamic file previews.',
    ],
  },
  // {
  //   institution: `Brigham and Women's`,
  //   role: 'Lead Software Engineer',
  //   date: '2023',
  //   bullets: [

  //   ]
  // }
]

const EDUCATION: ResumeEntry[] = [
  {
    institution: 'Worcester Polytechnic Institute',
    role: 'B.S. Computer Science',
    subheader: 'GPA: 3.7 / 4.0',
    date: '2020 - 2024',
    bullets: [
      'Graduated with honors, concentrating in machine learning, statistics and application development.',
      'Relevant coursework: Machine Learning, Operating Systems, Computer Networks, Data Structures & Algorithms.',
      'Senior capstone: Implemented a machine learning algorithm that provides targeted SCI recovery in rats.',
      'Senior thesis: Effects of wide spread LLM usage in education'
    ],
  },
]

// ── Icons ─────────────────────────────────────────────────────────────────────

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  )
}

function LinkedInIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  )
}

function ExternalLinkIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
    </svg>
  )
}

// ── ResumeCard ────────────────────────────────────────────────────────────────

function ResumeCard({ institution, role, subheader, date, bullets, links }: ResumeEntry) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      {/* Institution header */}
      <div className="px-6 py-4">
        <h3 className="text-sm font-semibold text-gray-900">{institution}</h3>
      </div>

      {/* Separator */}
      <div className="h-px bg-gray-100" />

      {/* Role + date row */}
      <div className="px-6 pt-4 pb-1 flex items-start justify-between gap-4">
        <span className="text-sm font-medium text-blue-600">{role}</span>
        <span className="text-xs text-gray-400 whitespace-nowrap pt-px">{date}</span>
      </div>

      {/* Optional subheader */}
      {subheader && (
        <div className="px-6 pb-3">
          <span className="text-xs font-medium text-gray-400">{subheader}</span>
        </div>
      )}

      {/* Bullet points */}
      <ul className={`px-6 space-y-1.5 ${links && links.length > 0 ? 'pb-4' : 'pb-5'} ${!subheader ? 'pt-3' : ''}`}>
        {bullets.map((b, i) => (
          <li key={i} className="flex gap-2 text-sm text-gray-500 leading-relaxed">
            <span className="mt-1.5 w-1 h-1 rounded-full bg-gray-300 shrink-0" />
            {b}
          </li>
        ))}
      </ul>

      {/* Optional links */}
      {links && links.length > 0 && (
        <>
          <div className="h-px bg-gray-100" />
          <div className="px-6 py-3 flex flex-wrap gap-2">
            {links.map((link) => (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-blue-600 bg-blue-50 rounded-full border border-blue-100 hover:bg-blue-100 transition-colors"
              >
                {link.label}
                <ExternalLinkIcon className="w-3 h-3" />
              </a>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ── Section heading ───────────────────────────────────────────────────────────

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <h2 className="text-xs font-semibold uppercase tracking-widest text-blue-600 whitespace-nowrap">
        {children}
      </h2>
      <div className="flex-1 h-px bg-gray-200" />
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

function RouteComponent() {
  return (
    <div className="min-h-screen bg-gray-50 pb-24">

      {/* Hero */}
      <section className="bg-white border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-6 py-14">
          <span className="text-xs font-semibold uppercase tracking-widest text-blue-600">
            About
          </span>
          <h1 className="text-3xl font-bold text-gray-900 mt-2 mb-3">Apollinaris Rowe</h1>
          <p className="text-gray-500 text-sm leading-relaxed max-w-xl mb-5">
            Software engineer focused on systems architecture, efficiency, and security.
          </p>

          {/* Social links */}
          <div className="flex items-center gap-3">
            <a
              href="https://linkedin.com/in/apollinaris-rowe"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-[#0A66C2] rounded-lg hover:bg-[#004182] transition-colors"
            >
              <LinkedInIcon className="w-4 h-4" />
              LinkedIn
            </a>
            <a
              href="https://github.com/apollorowe"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-gray-900 rounded-lg hover:bg-gray-700 transition-colors"
            >
              <GitHubIcon className="w-4 h-4" />
              GitHub
            </a>
          </div>
        </div>
      </section>

      {/* Content */}
      <div className="max-w-3xl mx-auto px-6 pt-12 space-y-12">

        {/* Experience */}
        <section>
          <SectionHeading>Experience</SectionHeading>
          <div className="space-y-4">
            {EXPERIENCE.map((e) => (
              <ResumeCard key={e.institution + e.role} {...e} />
            ))}
          </div>
        </section>

        {/* Education */}
        <section>
          <SectionHeading>Education</SectionHeading>
          <div className="space-y-4">
            {EDUCATION.map((e) => (
              <ResumeCard key={e.institution + e.role} {...e} />
            ))}
          </div>
        </section>

      </div>
    </div>
  )
}
