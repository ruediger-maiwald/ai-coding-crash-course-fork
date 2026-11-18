import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import type { getCourseAnalytics } from "~/services/analyticsService";

type CourseAnalytics = ReturnType<typeof getCourseAnalytics>;

const thClass =
  "px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground";
const thNumClass = `${thClass} text-right`;
const tdClass = "px-4 py-3 text-sm";
const tdNumClass = `${tdClass} text-right tabular-nums`;

/** 0–1 → "75%"; null (no attempts) → "—". */
function percent(value: number | null) {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function Section({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string | null;
  children: ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {empty ? (
        <p className="rounded-md border border-border px-4 py-6 text-center text-sm text-muted-foreground">
          {empty}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full">{children}</table>
        </div>
      )}
    </section>
  );
}

export function CourseStuckPoints({
  quizzes,
  mostDiscussedLessons,
}: Pick<CourseAnalytics, "quizzes" | "mostDiscussedLessons">) {
  return (
    <Card className="mt-8">
      <CardHeader>
        <CardTitle>Stuck points</CardTitle>
        <p className="text-sm text-muted-foreground">
          Quizzes students struggle with and lessons that raise the most
          discussion
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        <Section
          title="Quizzes"
          empty={quizzes.length === 0 ? "This course has no quizzes" : null}
        >
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className={thClass}>Quiz</th>
              <th className={thNumClass}>Attempts</th>
              <th className={thNumClass}>Pass rate</th>
              <th className={thNumClass}>Average score</th>
            </tr>
          </thead>
          <tbody>
            {quizzes.map((quiz) => (
              <tr
                key={quiz.quizId}
                className="border-b border-border last:border-0"
              >
                <td className={tdClass}>
                  <p className="font-medium">{quiz.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {quiz.lessonTitle}
                  </p>
                </td>
                <td className={tdNumClass}>{quiz.attempts}</td>
                <td className={tdNumClass}>{percent(quiz.passRate)}</td>
                <td className={tdNumClass}>{percent(quiz.averageScore)}</td>
              </tr>
            ))}
          </tbody>
        </Section>

        <Section
          title="Most-discussed lessons"
          empty={mostDiscussedLessons.length === 0 ? "No comments yet" : null}
        >
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className={thClass}>Lesson</th>
              <th className={thNumClass}>Comments</th>
            </tr>
          </thead>
          <tbody>
            {mostDiscussedLessons.map((lesson) => (
              <tr
                key={lesson.lessonId}
                className="border-b border-border last:border-0"
              >
                <td className={`${tdClass} font-medium`}>{lesson.title}</td>
                <td className={tdNumClass}>{lesson.comments}</td>
              </tr>
            ))}
          </tbody>
        </Section>
      </CardContent>
    </Card>
  );
}
