import { describe, expect, it } from "vitest";
import { LessonProgressStatus } from "../app/db/schema";
import { planAnalyticsSeed, type AnalyticsSeedInput } from "./seedAnalytics";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date("2026-06-15T12:00:00.000Z");

function quiz(
  quizId: number,
  lessonId: number,
  passingScore: number,
  questionCount: number
) {
  return {
    quizId,
    lessonId,
    passingScore,
    questions: Array.from({ length: questionCount }, (_, i) => ({
      questionId: quizId * 100 + i,
      correctOptionId: quizId * 1000 + i * 2,
      wrongOptionId: quizId * 1000 + i * 2 + 1,
    })),
  };
}

const course1Lessons = Array.from({ length: 19 }, (_, i) => 100 + i);
const course2Lessons = Array.from({ length: 20 }, (_, i) => 200 + i);

const input: AnalyticsSeedInput = {
  now,
  courses: [
    {
      courseId: 1,
      instructorId: 2,
      price: 4999,
      lessonIds: course1Lessons,
      quizzes: [
        quiz(1, course1Lessons[2], 0.7, 3),
        quiz(2, course1Lessons[7], 0.6, 2),
      ],
    },
    {
      courseId: 2,
      instructorId: 3,
      price: 5999,
      lessonIds: course2Lessons,
      quizzes: [quiz(3, course2Lessons[4], 0.7, 3)],
    },
  ],
};

const plan = planAnalyticsSeed(input);

function completionsPerLesson(lessonIds: number[]) {
  return lessonIds.map(
    (lessonId) =>
      plan.progress.filter(
        (p) =>
          p.lessonId === lessonId && p.status === LessonProgressStatus.Completed
      ).length
  );
}

describe("planAnalyticsSeed", () => {
  it("is the same on every run", () => {
    expect(planAnalyticsSeed(input)).toEqual(plan);
  });

  it("adds about 50 uniquely-emailed students", () => {
    expect(plan.students).toHaveLength(50);
    expect(new Set(plan.students.map((s) => s.email)).size).toBe(50);
  });

  it("enrolls a meaningful number of students in every course within the last 60 days", () => {
    for (const course of input.courses) {
      const enrollments = plan.enrollments.filter(
        (e) => e.courseId === course.courseId
      );
      expect(enrollments.length).toBeGreaterThanOrEqual(20);
    }
    for (const e of plan.enrollments) {
      const ageMs = now.getTime() - new Date(e.enrolledAt).getTime();
      expect(ageMs).toBeGreaterThanOrEqual(0);
      expect(ageMs).toBeLessThan(60 * DAY_MS);
    }
    // Enrollments land on many distinct days, including the last 30.
    const recentDays = new Set(
      plan.enrollments
        .filter(
          (e) => now.getTime() - new Date(e.enrolledAt).getTime() < 30 * DAY_MS
        )
        .map((e) => e.enrolledAt.slice(0, 10))
    );
    expect(recentDays.size).toBeGreaterThanOrEqual(10);
  });

  it("drops off across lesson order, with some students completing every lesson", () => {
    for (const course of input.courses) {
      const counts = completionsPerLesson(course.lessonIds);
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
      }
      expect(counts[0]).toBeGreaterThan(counts[counts.length - 1] * 1.5);
      expect(counts[counts.length - 1]).toBeGreaterThanOrEqual(2);
    }
  });

  it("only records progress, ratings and comments after enrollment and before now", () => {
    const enrolledAt = new Map(
      plan.enrollments.map((e) => [`${e.student}:${e.courseId}`, e.enrolledAt])
    );
    const courseOf = (lessonId: number) =>
      input.courses.find((c) => c.lessonIds.includes(lessonId))!.courseId;
    const nowIso = now.toISOString();

    for (const p of plan.progress.filter((p) => p.completedAt)) {
      const start = enrolledAt.get(`${p.student}:${courseOf(p.lessonId)}`)!;
      expect(p.completedAt! > start && p.completedAt! < nowIso).toBe(true);
    }
    for (const c of plan.comments) {
      const start = enrolledAt.get(`${c.student}:${courseOf(c.lessonId)}`)!;
      expect(c.createdAt > start && c.createdAt < nowIso).toBe(true);
    }
    for (const r of plan.ratings) {
      expect(enrolledAt.has(`${r.student}:${r.courseId}`)).toBe(true);
    }
  });

  it("includes both passing and failing quiz attempts, scored against the quiz's passing score", () => {
    expect(plan.quizAttempts.some((a) => a.passed)).toBe(true);
    expect(plan.quizAttempts.some((a) => !a.passed)).toBe(true);
    for (const a of plan.quizAttempts) {
      const q = input.courses
        .flatMap((c) => c.quizzes)
        .find((q) => q.quizId === a.quizId)!;
      expect(a.passed).toBe(a.score >= q.passingScore);
    }
  });

  it("has ratings spanning several values, at most one per student per course", () => {
    expect(
      new Set(plan.ratings.map((r) => r.rating)).size
    ).toBeGreaterThanOrEqual(4);
    const keys = plan.ratings.map((r) => `${r.student}:${r.courseId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("mixes full-price, PPP, team and purchase-free enrollments", () => {
    const fullPrice = plan.purchases.filter(
      (p) =>
        p.amountPaid ===
        input.courses.find((c) => c.courseId === p.courseId)!.price
    );
    const ppp = plan.purchases.filter(
      (p) =>
        p.amountPaid <
        input.courses.find((c) => c.courseId === p.courseId)!.price
    );
    expect(fullPrice.length).toBeGreaterThan(0);
    expect(ppp.length).toBeGreaterThan(0);

    expect(plan.team).not.toBeNull();
    expect(plan.team!.redemptions.length).toBeGreaterThan(0);
    expect(plan.team!.couponCodes.length).toBeGreaterThan(
      plan.team!.redemptions.length
    );

    const purchased = new Set(
      plan.purchases.map((p) => `${p.student}:${p.courseId}`)
    );
    const redeemed = new Set(
      plan.team!.redemptions.map((r) => `${r.student}:${plan.team!.courseId}`)
    );
    const free = plan.enrollments.filter(
      (e) =>
        !purchased.has(`${e.student}:${e.courseId}`) &&
        !redeemed.has(`${e.student}:${e.courseId}`)
    );
    expect(free.length).toBeGreaterThan(0);
  });

  it("soft-deletes some comments and replies to the rest", () => {
    const deleted = plan.comments.filter((c) => c.deletedAt);
    const live = plan.comments.filter((c) => !c.deletedAt);
    expect(deleted.length).toBeGreaterThan(0);
    expect(live.length).toBeGreaterThan(deleted.length);
    expect(live.every((c) => c.reply)).toBe(true);
  });
});
