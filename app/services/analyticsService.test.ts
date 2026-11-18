import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import {
  getDailyEnrollments,
  getInstructorCourseStats,
  getInstructorSummary,
} from "./analyticsService";

function createUser(name: string, role: schema.UserRole) {
  return testDb
    .insert(schema.users)
    .values({
      name,
      email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.com`,
      role,
    })
    .returning()
    .get();
}

function createCourse(instructorId: number, slug: string) {
  return testDb
    .insert(schema.courses)
    .values({
      title: slug,
      slug,
      description: "A course",
      salesCopy: "Sales copy.",
      instructorId,
      categoryId: base.category.id,
      status: schema.CourseStatus.Draft,
    })
    .returning()
    .get();
}

function createModule(courseId: number, position: number) {
  return testDb
    .insert(schema.modules)
    .values({ courseId, title: `Module ${position}`, position })
    .returning()
    .get();
}

function createLessons(moduleId: number, count: number) {
  const ids: number[] = [];
  for (let i = 1; i <= count; i++) {
    const lesson = testDb
      .insert(schema.lessons)
      .values({ moduleId, title: `Lesson ${i}`, position: i })
      .returning()
      .get();
    ids.push(lesson.id);
  }
  return ids;
}

function completeLesson(userId: number, lessonId: number, completedAt: string) {
  testDb
    .insert(schema.lessonProgress)
    .values({
      userId,
      lessonId,
      status: schema.LessonProgressStatus.Completed,
      completedAt,
    })
    .run();
}

function createPurchase(
  userId: number,
  courseId: number,
  amountPaid: number,
  createdAt: string
) {
  return testDb
    .insert(schema.purchases)
    .values({ userId, courseId, amountPaid, createdAt })
    .returning()
    .get();
}

function rate(
  userId: number,
  courseId: number,
  rating: number,
  createdAt: string
) {
  testDb
    .insert(schema.courseRatings)
    .values({ userId, courseId, rating, createdAt, updatedAt: createdAt })
    .run();
}

/** Redeem one seat of a team purchase; the redeemer has no purchase of their own. */
function redeemTeamSeat(
  purchase: { id: number; courseId: number },
  userId: number,
  redeemedAt: string
) {
  const team = testDb.insert(schema.teams).values({}).returning().get();
  testDb
    .insert(schema.coupons)
    .values({
      teamId: team.id,
      courseId: purchase.courseId,
      code: `SEAT-${purchase.id}-${userId}`,
      purchaseId: purchase.id,
      redeemedByUserId: userId,
      redeemedAt,
    })
    .run();
}

function enroll(userId: number, courseId: number, enrolledAt?: string) {
  testDb
    .insert(schema.enrollments)
    .values({ userId, courseId, enrolledAt })
    .run();
}

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
});

describe("getInstructorCourseStats", () => {
  it("returns lesson and student counts for each of the instructor's courses", () => {
    // Course 1: 2 modules with 3 + 2 lessons, 2 students.
    const m1 = createModule(base.course.id, 1);
    const m2 = createModule(base.course.id, 2);
    createLessons(m1.id, 3);
    createLessons(m2.id, 2);
    enroll(base.user.id, base.course.id);
    enroll(
      createUser("Second Student", schema.UserRole.Student).id,
      base.course.id
    );

    // Course 2: 1 module with 4 lessons, 1 student.
    const course2 = createCourse(base.instructor.id, "second-course");
    createLessons(createModule(course2.id, 1).id, 4);
    enroll(base.user.id, course2.id);

    const stats = getInstructorCourseStats(base.instructor.id);

    expect(stats).toMatchObject([
      { id: base.course.id, lessonCount: 5, enrollmentCount: 2 },
      { id: course2.id, lessonCount: 4, enrollmentCount: 1 },
    ]);
  });

  it("returns 0 for courses with no lessons or enrollments", () => {
    // A module with no lessons still counts as zero lessons.
    createModule(base.course.id, 1);
    const emptyCourse = createCourse(base.instructor.id, "empty-course");

    const stats = getInstructorCourseStats(base.instructor.id);

    expect(stats).toMatchObject([
      { id: base.course.id, lessonCount: 0, enrollmentCount: 0 },
      { id: emptyCourse.id, lessonCount: 0, enrollmentCount: 0 },
    ]);
  });

  it("excludes other instructors' courses and their enrollments", () => {
    const otherInstructor = createUser(
      "Other Instructor",
      schema.UserRole.Instructor
    );
    const otherCourse = createCourse(otherInstructor.id, "other-course");
    createLessons(createModule(otherCourse.id, 1).id, 3);
    enroll(base.user.id, otherCourse.id);

    expect(
      getInstructorCourseStats(base.instructor.id).map((c) => c.id)
    ).toEqual([base.course.id]);
    expect(getInstructorCourseStats(otherInstructor.id)).toMatchObject([
      { id: otherCourse.id, lessonCount: 3, enrollmentCount: 1 },
    ]);
  });

  it("returns an empty list for an instructor with no courses", () => {
    const newInstructor = createUser(
      "New Instructor",
      schema.UserRole.Instructor
    );

    expect(getInstructorCourseStats(newInstructor.id)).toEqual([]);
  });
});

// ─── Summary KPIs ───

const NOW = new Date("2026-06-15T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO timestamp `days` before the pinned "now". */
function daysAgo(days: number) {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

describe("getInstructorSummary", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("students", () => {
    it("counts every enrollment all-time and those enrolled in the last 30 days", () => {
      const course2 = createCourse(base.instructor.id, "second-course");
      const alice = createUser("Alice", schema.UserRole.Student);
      enroll(base.user.id, base.course.id, daysAgo(45));
      enroll(alice.id, base.course.id, daysAgo(10));
      enroll(base.user.id, course2.id, daysAgo(1));

      expect(getInstructorSummary(base.instructor.id).students).toEqual({
        allTime: 3,
        last30Days: 2,
      });
    });
  });

  describe("completion", () => {
    it("counts a student as completed only once every lesson is done, dated by their latest completion", () => {
      const [l1, l2, l3] = createLessons(createModule(base.course.id, 1).id, 3);
      const [finishedRecently, finishedLongAgo, partway, notStarted] = [
        "Finished Recently",
        "Finished Long Ago",
        "Partway",
        "Not Started",
      ].map((name) => createUser(name, schema.UserRole.Student));
      for (const s of [
        finishedRecently,
        finishedLongAgo,
        partway,
        notStarted,
      ]) {
        enroll(s.id, base.course.id, daysAgo(50));
      }

      // Finished 5 days ago, though the first lessons were done long before.
      completeLesson(finishedRecently.id, l1, daysAgo(45));
      completeLesson(finishedRecently.id, l2, daysAgo(40));
      completeLesson(finishedRecently.id, l3, daysAgo(5));
      // Finished 35 days ago — completed, but outside the window.
      completeLesson(finishedLongAgo.id, l1, daysAgo(40));
      completeLesson(finishedLongAgo.id, l2, daysAgo(38));
      completeLesson(finishedLongAgo.id, l3, daysAgo(35));
      // Two of three lessons, the latest recently — not completed.
      completeLesson(partway.id, l1, daysAgo(10));
      completeLesson(partway.id, l2, daysAgo(2));
      // An in-progress record on the last lesson doesn't count.
      testDb
        .insert(schema.lessonProgress)
        .values({
          userId: partway.id,
          lessonId: l3,
          status: schema.LessonProgressStatus.InProgress,
        })
        .run();

      expect(getInstructorSummary(base.instructor.id).completion).toEqual({
        rate: 0.5,
        finishedLast30Days: 1,
      });
    });

    it("un-completes students when a lesson they haven't done is added", () => {
      const mod = createModule(base.course.id, 1);
      const [l1, l2] = createLessons(mod.id, 2);
      enroll(base.user.id, base.course.id, daysAgo(20));
      completeLesson(base.user.id, l1, daysAgo(10));
      completeLesson(base.user.id, l2, daysAgo(5));

      expect(getInstructorSummary(base.instructor.id).completion).toEqual({
        rate: 1,
        finishedLast30Days: 1,
      });

      createLessons(createModule(base.course.id, 2).id, 1);

      expect(getInstructorSummary(base.instructor.id).completion).toEqual({
        rate: 0,
        finishedLast30Days: 0,
      });
    });

    it("counts paid, coupon/team and free enrollments in the denominator", () => {
      const [l1] = createLessons(createModule(base.course.id, 1).id, 1);
      const [paid, coupon, free] = ["Paid", "Coupon", "Free"].map((name) =>
        createUser(name, schema.UserRole.Student)
      );
      for (const s of [paid, coupon, free])
        enroll(s.id, base.course.id, daysAgo(20));

      // Only the paying student has a purchase; the coupon student redeemed a
      // seat from someone else's team purchase.
      const buyer = createUser("Team Buyer", schema.UserRole.Student);
      createPurchase(paid.id, base.course.id, 4999, daysAgo(20));
      const teamPurchase = createPurchase(
        buyer.id,
        base.course.id,
        4999 * 3,
        daysAgo(25)
      );
      redeemTeamSeat(teamPurchase, coupon.id, daysAgo(20));

      completeLesson(free.id, l1, daysAgo(3));

      expect(
        getInstructorSummary(base.instructor.id).completion.rate
      ).toBeCloseTo(1 / 3);
    });
  });

  describe("rating", () => {
    it("averages all ratings and those created in the last 30 days", () => {
      const course2 = createCourse(base.instructor.id, "second-course");
      const [a, b] = ["A", "B"].map((n) =>
        createUser(n, schema.UserRole.Student)
      );
      rate(a.id, base.course.id, 5, daysAgo(40));
      rate(b.id, base.course.id, 3, daysAgo(10));
      rate(a.id, course2.id, 4, daysAgo(2));

      expect(getInstructorSummary(base.instructor.id).rating).toEqual({
        allTime: { average: 4, count: 3 },
        last30Days: { average: 3.5, count: 2 },
      });
    });

    it("has no average when there are no ratings at all", () => {
      expect(getInstructorSummary(base.instructor.id).rating).toEqual({
        allTime: { average: null, count: 0 },
        last30Days: { average: null, count: 0 },
      });
    });

    it("has no recent average when every rating is older than 30 days", () => {
      rate(base.user.id, base.course.id, 5, daysAgo(45));

      expect(getInstructorSummary(base.instructor.id).rating).toEqual({
        allTime: { average: 5, count: 1 },
        last30Days: { average: null, count: 0 },
      });
    });
  });

  describe("revenue", () => {
    it("sums amounts paid, counting PPP at the amount paid and a team purchase once", () => {
      const [full, ppp, buyer, seat1, seat2] = [
        "Full",
        "PPP",
        "Buyer",
        "Seat 1",
        "Seat 2",
      ].map((n) => createUser(n, schema.UserRole.Student));
      createPurchase(full.id, base.course.id, 4999, daysAgo(40));
      createPurchase(ppp.id, base.course.id, 2500, daysAgo(10));

      // A 3-seat team purchase with two seats redeemed is one purchase row.
      const teamPurchase = createPurchase(
        buyer.id,
        base.course.id,
        4999 * 3,
        daysAgo(5)
      );
      for (const seat of [seat1, seat2]) {
        redeemTeamSeat(teamPurchase, seat.id, daysAgo(4));
        enroll(seat.id, base.course.id, daysAgo(4));
      }

      expect(getInstructorSummary(base.instructor.id).revenue).toEqual({
        allTime: 4999 + 2500 + 4999 * 3,
        last30Days: 2500 + 4999 * 3,
      });
    });

    it("is 0 with no purchases", () => {
      enroll(base.user.id, base.course.id, daysAgo(3));

      expect(getInstructorSummary(base.instructor.id).revenue).toEqual({
        allTime: 0,
        last30Days: 0,
      });
    });
  });

  describe("30-day window", () => {
    it("includes records exactly 30 days old and excludes anything older", () => {
      const atBoundary = daysAgo(30);
      const justOutside = new Date(
        NOW.getTime() - 30 * DAY_MS - 1
      ).toISOString();
      const [l1] = createLessons(createModule(base.course.id, 1).id, 1);
      const [inside, outside] = ["Inside", "Outside"].map((n) =>
        createUser(n, schema.UserRole.Student)
      );

      for (const [student, at] of [
        [inside, atBoundary],
        [outside, justOutside],
      ] as const) {
        enroll(student.id, base.course.id, at);
        completeLesson(student.id, l1, at);
        rate(student.id, base.course.id, student === inside ? 5 : 1, at);
        createPurchase(
          student.id,
          base.course.id,
          student === inside ? 1000 : 9000,
          at
        );
      }

      const summary = getInstructorSummary(base.instructor.id);
      expect(summary.students.last30Days).toBe(1);
      expect(summary.completion.finishedLast30Days).toBe(1);
      expect(summary.rating.last30Days).toEqual({ average: 5, count: 1 });
      expect(summary.revenue.last30Days).toBe(1000);
    });
  });

  it("never includes another instructor's courses", () => {
    const other = createUser("Other Instructor", schema.UserRole.Instructor);
    const otherCourse = createCourse(other.id, "other-course");
    const [l1] = createLessons(createModule(otherCourse.id, 1).id, 1);
    enroll(base.user.id, otherCourse.id, daysAgo(3));
    completeLesson(base.user.id, l1, daysAgo(2));
    rate(base.user.id, otherCourse.id, 5, daysAgo(2));
    createPurchase(base.user.id, otherCourse.id, 4999, daysAgo(3));

    expect(getInstructorSummary(base.instructor.id)).toEqual({
      students: { allTime: 0, last30Days: 0 },
      completion: { rate: 0, finishedLast30Days: 0 },
      rating: {
        allTime: { average: null, count: 0 },
        last30Days: { average: null, count: 0 },
      },
      revenue: { allTime: 0, last30Days: 0 },
    });
    expect(getInstructorSummary(other.id)).toEqual({
      students: { allTime: 1, last30Days: 1 },
      completion: { rate: 1, finishedLast30Days: 1 },
      rating: {
        allTime: { average: 5, count: 1 },
        last30Days: { average: 5, count: 1 },
      },
      revenue: { allTime: 4999, last30Days: 4999 },
    });
  });
});

describe("getDailyEnrollments", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function student(n: number) {
    return createUser(`Daily Student ${n}`, schema.UserRole.Student);
  }

  it("returns exactly 30 zero-filled UTC days ending today", () => {
    const days = getDailyEnrollments(base.instructor.id);

    expect(days).toHaveLength(30);
    expect(days[0]).toEqual({ date: "2026-05-17", count: 0 });
    expect(days[29]).toEqual({ date: "2026-06-15", count: 0 });
    expect(days.every((d) => d.count === 0)).toBe(true);
    // Consecutive days, no gaps.
    for (let i = 1; i < days.length; i++) {
      expect(Date.parse(days[i].date) - Date.parse(days[i - 1].date)).toBe(
        DAY_MS
      );
    }
  });

  it("buckets enrollments by UTC day across all of the instructor's courses", () => {
    const course2 = createCourse(base.instructor.id, "second-course");
    // Both ends of the same UTC day land in one bucket.
    enroll(student(1).id, base.course.id, "2026-06-10T00:00:00.000Z");
    enroll(student(2).id, course2.id, "2026-06-10T23:59:59.999Z");
    enroll(student(3).id, base.course.id, "2026-06-11T00:00:00.000Z");
    // Earlier today, before "now".
    enroll(student(4).id, course2.id, "2026-06-15T01:00:00.000Z");

    const counts = Object.fromEntries(
      getDailyEnrollments(base.instructor.id).map((d) => [d.date, d.count])
    );

    expect(counts["2026-06-09"]).toBe(0);
    expect(counts["2026-06-10"]).toBe(2);
    expect(counts["2026-06-11"]).toBe(1);
    expect(counts["2026-06-12"]).toBe(0);
    expect(counts["2026-06-15"]).toBe(1);
  });

  it("includes the whole first UTC day and nothing before it", () => {
    enroll(student(1).id, base.course.id, "2026-05-17T00:00:00.000Z");
    enroll(student(2).id, base.course.id, "2026-05-16T23:59:59.999Z");

    const days = getDailyEnrollments(base.instructor.id);

    expect(days[0]).toEqual({ date: "2026-05-17", count: 1 });
    expect(days.reduce((sum, d) => sum + d.count, 0)).toBe(1);
  });

  it("excludes other instructors' enrollments", () => {
    const other = createUser("Other Instructor", schema.UserRole.Instructor);
    const otherCourse = createCourse(other.id, "other-course");
    enroll(student(1).id, otherCourse.id, daysAgo(1));
    enroll(student(2).id, base.course.id, daysAgo(1));

    const total = (instructorId: number) =>
      getDailyEnrollments(instructorId).reduce((sum, d) => sum + d.count, 0);

    expect(total(base.instructor.id)).toBe(1);
    expect(total(other.id)).toBe(1);
  });
});
