import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "~/components/ui/chart";
import type { getDailyEnrollments } from "~/services/analyticsService";

type DailyEnrollments = ReturnType<typeof getDailyEnrollments>;

const chartConfig = {
  count: { label: "Enrollments", color: "var(--chart-1)" },
} satisfies ChartConfig;

/** "2026-06-15" → "Jun 15", read as a UTC day so it never shifts by timezone. */
function formatDay(date: string) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function InstructorEnrollmentChart({
  days,
}: {
  days: DailyEnrollments;
}) {
  const total = days.reduce((sum, d) => sum + d.count, 0);

  return (
    <Card className="mb-8">
      <CardHeader>
        <CardTitle>New enrollments per day</CardTitle>
        <p className="text-sm text-muted-foreground">
          {total.toLocaleString("en-US")} across all your courses over the last{" "}
          {days.length} UTC days
        </p>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="h-64 w-full">
          <LineChart data={days} margin={{ left: 0, right: 12 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={24}
              tickFormatter={formatDay}
            />
            <YAxis
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              width={32}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(label) => formatDay(String(label))}
                />
              }
            />
            <Line
              dataKey="count"
              type="monotone"
              stroke="var(--color-count)"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
