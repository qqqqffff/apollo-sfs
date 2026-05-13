import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/about')({
  component: RouteComponent,
})

// ── Types ──────────────────────────────────────────────────────────────────────

interface ResumeEntry {
  institution: string
  role: string
  date: string
  bullets: string[]
}

// ── Sample data (replace with your own) ───────────────────────────────────────

const EXPERIENCE: ResumeEntry[] = [
  {
    institution: 'Apollo Software Services',
    role: 'Founder & Full-Stack Engineer',
    date: '2024 – Present',
    bullets: [
      'Designed and built Apollo SFS, a self-hosted encrypted file storage platform running on bare-metal NVMe hardware.',
      'Implemented double-layer AES-256 encryption at rest, invite-only access control, and real-time admin metrics.',
      'Architected a multi-server, multi-drive storage backend with automatic capacity-aware user allocation.',
    ],
  },
]

const EDUCATION: ResumeEntry[] = [
  {
    institution: 'Sample University',
    role: 'B.S. Computer Science',
    date: '2020 – 2024',
    bullets: [
      'Graduated with honours, concentrating in systems programming and distributed systems.',
      'Relevant coursework: Operating Systems, Computer Networks, Algorithms, Database Systems.',
      'Senior capstone: designed and implemented a distributed key-value store with Raft consensus.',
    ],
  },
]

const SKILLS: string[][] = [
  ['Go', 'TypeScript', 'Python', 'SQL'],
  ['React', 'TanStack Router', 'Tailwind CSS'],
  ['PostgreSQL', 'MinIO', 'Docker', 'Nginx'],
  ['AES-256 encryption', 'REST API design', 'Linux systems'],
]

// ── ResumeCard ────────────────────────────────────────────────────────────────

function ResumeCard({ institution, role, date, bullets }: ResumeEntry) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      {/* Institution header */}
      <div className="px-6 py-4">
        <h3 className="text-sm font-semibold text-gray-900">{institution}</h3>
      </div>

      {/* Separator */}
      <div className="h-px bg-gray-100" />

      {/* Role + date row */}
      <div className="px-6 pt-4 pb-3 flex items-start justify-between gap-4">
        <span className="text-sm font-medium text-blue-600">{role}</span>
        <span className="text-xs text-gray-400 whitespace-nowrap pt-px">{date}</span>
      </div>

      {/* Bullet points */}
      <ul className="px-6 pb-5 space-y-1.5">
        {bullets.map((b, i) => (
          <li key={i} className="flex gap-2 text-sm text-gray-500 leading-relaxed">
            <span className="mt-1.5 w-1 h-1 rounded-full bg-gray-300 shrink-0" />
            {b}
          </li>
        ))}
      </ul>
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
          <h1 className="text-3xl font-bold text-gray-900 mt-2 mb-3">Apollo Rowe</h1>
          <p className="text-gray-500 text-sm leading-relaxed max-w-xl">
            Software engineer focused on systems programming, encrypted storage, and full-stack
            web development. I design and build the software I want to exist — private,
            efficient, and running on hardware I control.
          </p>
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

        {/* Skills */}
        <section>
          <SectionHeading>Skills</SectionHeading>
          <div className="bg-white rounded-xl border border-gray-200 px-6 py-5 flex flex-wrap gap-2">
            {SKILLS.flat().map((skill) => (
              <span
                key={skill}
                className="px-3 py-1 text-xs font-medium text-blue-700 bg-blue-50 rounded-full border border-blue-100"
              >
                {skill}
              </span>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
