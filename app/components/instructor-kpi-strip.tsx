import type { ReactNode } from "react";
import { CheckCircle2, DollarSign, Star, Users } from "lucide-react";
import { Card, CardContent } from "~/components/ui/card";
import type { KpiSummary } from "~/services/analyticsService";

/** Cents → "$1,234" or "$1,234.56". Zero shows as "$0", never "Free". */
function formatUsd(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

function plural(n: number, word: string) {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

function KpiCard({
  label,
  icon,
  value,
  detail,
}: {
  label: string;
  icon: ReactNode;
  value: string;
  detail: string;
}) {
  return (
    <Card className="py-4">
      <CardContent className="px-4">
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{label}</span>
          {icon}
        </div>
        <div className="mt-2 text-2xl font-bold">{value}</div>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

export function InstructorKpiStrip({
  summary,
}: {
  summary: KpiSummary;
}) {
  const { students, completion, rating, revenue } = summary;
  const iconClass = "size-4";

  const recentRating =
    rating.last30Days.average === null
      ? "No ratings in the last 30 days"
      : `${rating.last30Days.average.toFixed(1)} from ${rating.last30Days.count} in the last 30 days`;

  return (
    <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <KpiCard
        label="Students"
        icon={<Users className={iconClass} />}
        value={students.allTime.toLocaleString("en-US")}
        detail={`${students.last30Days.toLocaleString("en-US")} enrolled in the last 30 days`}
      />
      <KpiCard
        label="Completion"
        icon={<CheckCircle2 className={iconClass} />}
        value={`${Math.round(completion.rate * 100)}%`}
        detail={`${plural(completion.finishedLast30Days, "student")} finished in the last 30 days`}
      />
      <KpiCard
        label="Rating"
        icon={<Star className={iconClass} />}
        value={
          rating.allTime.average === null
            ? "—"
            : rating.allTime.average.toFixed(1)
        }
        detail={
          rating.allTime.average === null
            ? "No ratings yet"
            : `${plural(rating.allTime.count, "rating")} · ${recentRating}`
        }
      />
      <KpiCard
        label="Revenue"
        icon={<DollarSign className={iconClass} />}
        value={formatUsd(revenue.allTime)}
        detail={`${formatUsd(revenue.last30Days)} in the last 30 days`}
      />
    </div>
  );
}
