export interface StatStripItem {
  label: string;
  value: string;
}

interface StatStripProps {
  items: StatStripItem[];
  columns?: 3 | 4 | 8;
}

const COLUMNS: Record<3 | 4 | 8, string> = {
  3: 'sm:grid-cols-3',
  4: 'sm:grid-cols-4',
  8: 'sm:grid-cols-4 lg:grid-cols-8',
};

export function StatStrip({ items, columns = 4 }: StatStripProps) {
  return (
    <dl
      className={`grid grid-cols-2 gap-x-4 gap-y-2 border-y border-line py-2 ${COLUMNS[columns]}`}
    >
      {items.map((item) => (
        <div key={item.label} className="flex min-w-0 flex-col gap-0.5">
          <dd className="font-serif text-xl leading-none text-ink">{item.value}</dd>
          <dt className="truncate text-[10px] uppercase tracking-[0.12em] text-muted">
            {item.label}
          </dt>
        </div>
      ))}
    </dl>
  );
}
