import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "~/components/ui/chart";
import type { getCourseAnalytics } from "~/services/analyticsService";

type DropOff = ReturnType<typeof getCourseAnalytics>["dropOff"];

const chartConfig = {
  percent: { label: "Completed", color: "var(--chart-1)" },
} satisfies ChartConfig;

export function CourseDropOffChart({
  dropOff,
  enrolled,
}: {
  dropOff: DropOff;
  enrolled: number;
}) {
  const data = dropOff.map((lesson, i) => ({
    order: i + 1,
    title: lesson.title,
    percent: Math.round(lesson.rate * 100),
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Lesson drop-off</CardTitle>
        <p className="text-sm text-muted-foreground">
          Share of enrolled students who completed each lesson, in course order
        </p>
      </CardHeader>
      <CardContent>
        {enrolled === 0 || data.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            {enrolled === 0
              ? "No students enrolled yet"
              : "This course has no lessons yet"}
          </p>
        ) : (
          <ChartContainer config={chartConfig} className="h-72 w-full">
            <BarChart data={data} margin={{ left: 0, right: 12 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="order"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
              />
              <YAxis
                domain={[0, 100]}
                tickFormatter={(v) => `${v}%`}
                tickLine={false}
                axisLine={false}
                width={40}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(_, payload) => {
                      const lesson = payload[0]?.payload as
                        (typeof data)[number] | undefined;
                      return lesson ? `${lesson.order}. ${lesson.title}` : null;
                    }}
                    formatter={(value) => `${value}% completed`}
                  />
                }
              />
              <Bar
                dataKey="percent"
                fill="var(--color-percent)"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
