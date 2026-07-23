import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { MdBolt, MdStorage, MdSpeed } from 'react-icons/md'
import { publicDriveBenchmarkQueryOptions } from '../api/interest'
import type { PublicTierBenchmarkStat } from '../api/interest'

export const Route = createFileRoute('/blog/drive-speed-benchmark')({
  component: RouteComponent,
})

function TierStatCard({
  label, icon: Icon, accent, stat,
}: {
  label: string
  icon: typeof MdBolt
  accent: 'blue' | 'amber'
  stat?: PublicTierBenchmarkStat
}) {
  const iconBg = accent === 'blue' ? 'bg-blue-50 text-blue-600' : 'bg-amber-50 text-amber-600'
  return (
    <div className="bg-white rounded-xl border border-gray-200 px-6 py-6 flex-1">
      <div className="flex items-center gap-2 mb-4">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${iconBg}`}>
          <Icon className="text-base" />
        </div>
        <h3 className="text-sm font-semibold text-gray-900 m-0">{label}</h3>
      </div>
      {stat ? (
        <>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-1.5 mt-0">Sequential</p>
          <div className="flex items-baseline gap-4 mb-1">
            <div>
              <span className="text-2xl font-bold text-gray-900 tabular-nums">{stat.seq_write_mbps.toFixed(0)}</span>
              <span className="text-xs text-gray-400 ml-1">MB/s write</span>
            </div>
          </div>
          <div className="flex items-baseline gap-4 mb-3">
            <div>
              <span className="text-2xl font-bold text-gray-900 tabular-nums">{stat.seq_read_mbps.toFixed(0)}</span>
              <span className="text-xs text-gray-400 ml-1">MB/s read</span>
            </div>
          </div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 mb-1.5 mt-0">Random (4K)</p>
          <div className="flex items-baseline gap-4 mb-1">
            <div>
              <span className="text-lg font-bold text-gray-900 tabular-nums">{stat.random_write_iops.toFixed(0)}</span>
              <span className="text-xs text-gray-400 ml-1">IOPS write</span>
            </div>
          </div>
          <div className="flex items-baseline gap-4 mb-3">
            <div>
              <span className="text-lg font-bold text-gray-900 tabular-nums">{stat.random_read_iops.toFixed(0)}</span>
              <span className="text-xs text-gray-400 ml-1">IOPS read</span>
            </div>
          </div>
          <p className="text-xs text-gray-400 m-0">
            Averaged across {stat.disk_count} disk{stat.disk_count === 1 ? '' : 's'} · tested{' '}
            {new Date(stat.tested_at).toLocaleDateString()}
          </p>
        </>
      ) : (
        <p className="text-sm text-gray-400 m-0">Benchmark results coming soon — check back after our next infrastructure test.</p>
      )}
    </div>
  )
}

function RouteComponent() {
  const { data } = useQuery(publicDriveBenchmarkQueryOptions)

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      {/* Hero */}
      <section className="bg-white border-b border-gray-200">
        <div className="max-w-3xl mx-auto px-6 py-14">
          <span className="text-xs font-semibold uppercase tracking-widest text-blue-600">Blog</span>
          <h1 className="text-3xl font-bold text-gray-900 mt-2 mb-3">How fast is Apollo SFS storage, really?</h1>
          <p className="text-gray-500 text-sm leading-relaxed max-w-xl mb-0">
            Every Apollo SFS server splits storage across two hardware tiers. We benchmark both directly
            on our own infrastructure — here's what the numbers say, and what each tier is actually good for.
          </p>
        </div>
      </section>

      <div className="max-w-3xl mx-auto px-6 pt-12 space-y-12">
        {/* Results */}
        <section>
          <div className="flex items-center gap-3 mb-4">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-blue-600 whitespace-nowrap">
              Benchmark results
            </h2>
            <div className="flex-1 h-px bg-gray-200" />
          </div>
          <div className="flex flex-col sm:flex-row gap-4">
            <TierStatCard label="Fast tier (NVMe)" icon={MdBolt} accent="blue" stat={data?.fast} />
            <TierStatCard label="Standard tier (HDD)" icon={MdStorage} accent="amber" stat={data?.standard} />
          </div>
          <p className="text-xs text-gray-400 mt-3 mb-0">
            Methodology: two passes on each physical drive, both bypassing the OS page cache so every number
            reflects the real device rather than a RAM round-trip. Sequential — one large write (fsync'd to
            disk) followed by a sequential read of a fixed-size test file. Random (4K) — fixed 4 KiB reads and
            writes at random offsets within that file, the industry-standard way to measure small-file,
            seek-heavy performance. The fast tier's figures are the average of both pooled NVMe drives; the
            standard tier is the single HDD.
          </p>
        </section>

        {/* Fast tier */}
        <section className="bg-white rounded-xl border border-gray-200 px-8 py-8">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
              <MdSpeed className="text-blue-600 text-xl" />
            </div>
            <div>
              <span className="text-xs font-semibold uppercase tracking-widest text-blue-600">Fast tier</span>
              <h2 className="text-xl font-bold text-gray-900 mt-1 mb-3">NVMe — built for active files</h2>
              <p className="text-sm text-gray-500 leading-relaxed max-w-2xl mb-3">
                The fast tier runs on a pool of solid-state NVMe drives with no moving parts, giving it far
                lower latency and much higher random I/O performance than a spinning disk. That translates
                directly into a snappier experience for anything you're actively working with:
              </p>
              <ul className="text-sm text-gray-500 leading-relaxed max-w-2xl space-y-1.5 mb-0 pl-5 list-disc">
                <li>Instant thumbnails and previews for photos, PDFs, and video</li>
                <li>Fast folder browsing even with thousands of files</li>
                <li>Best choice for files you upload, open, and edit often</li>
              </ul>
            </div>
          </div>
        </section>

        {/* Standard tier */}
        <section className="bg-white rounded-xl border border-gray-200 px-8 py-8">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-lg bg-amber-50 flex items-center justify-center shrink-0">
              <MdStorage className="text-amber-600 text-xl" />
            </div>
            <div>
              <span className="text-xs font-semibold uppercase tracking-widest text-amber-600">Standard tier</span>
              <h2 className="text-xl font-bold text-gray-900 mt-1 mb-3">HDD — built for capacity</h2>
              <p className="text-sm text-gray-500 leading-relaxed max-w-2xl mb-3">
                The standard tier trades some raw speed for a much larger amount of storage per dollar. A
                traditional hard drive is still a great fit for a lot of what people store:
              </p>
              <ul className="text-sm text-gray-500 leading-relaxed max-w-2xl space-y-1.5 mb-0 pl-5 list-disc">
                <li>Cold storage and archives you rarely open</li>
                <li>Backups and large media libraries</li>
                <li>Bulk capacity at a lower cost when you don't need instant access</li>
              </ul>
            </div>
          </div>
        </section>

        <div className="text-center">
          <Link
            to="/"
            className="inline-block px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl no-underline transition-colors shadow-sm"
          >
            Back to Apollo SFS
          </Link>
        </div>
      </div>
    </div>
  )
}
