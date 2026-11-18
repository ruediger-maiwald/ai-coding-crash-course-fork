import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../app/db/schema";
import {
  LessonProgressStatus,
  TeamMemberRole,
  UserRole,
} from "../app/db/schema";

// ─── Analytics seed ───
// Adds ~50 generated students with activity spread over the last 60 days, so
// instructor analytics (KPIs, enrollments per day, lesson drop-off, quiz stats)
// have visible shape in development.
//
// Everything is derived from a fixed hash of (student, course, purpose) — no
// Math.random — so every seed run produces the same rows. Only the timestamps
// move, because they are relative to the seed time.

const STUDENT_COUNT = 50;
const WINDOW_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AnalyticsSeedQuiz {
  quizId: number;
  lessonId: number;
  passingScore: number;
  questions: {
    questionId: number;
    correctOptionId: number;
    wrongOptionId: number;
  }[];
}

export interface AnalyticsSeedCourse {
  courseId: number;
  instructorId: number;
  /** Full price in cents. */
  price: number;
  /** Every lesson in the course, in course order (module, then lesson position). */
  lessonIds: number[];
  quizzes: AnalyticsSeedQuiz[];
}

export interface AnalyticsSeedInput {
  now: Date;
  courses: AnalyticsSeedCourse[];
}

type StudentRef = number; // index into plan.students

interface SeedUser {
  name: string;
  email: string;
  avatarUrl: string;
  createdAt: string;
}

export interface AnalyticsSeedPlan {
  students: SeedUser[];
  enrollments: { student: StudentRef; courseId: number; enrolledAt: string }[];
  progress: {
    student: StudentRef;
    lessonId: number;
    status: LessonProgressStatus;
    completedAt: string | null;
  }[];
  quizAttempts: {
    student: StudentRef;
    quizId: number;
    score: number;
    passed: boolean;
    attemptedAt: string;
    answers: { questionId: number; selectedOptionId: number }[];
  }[];
  ratings: {
    student: StudentRef;
    courseId: number;
    rating: number;
    createdAt: string;
  }[];
  comments: {
    student: StudentRef;
    lessonId: number;
    body: string;
    createdAt: string;
    deletedAt: string | null;
    reply: { authorId: number; body: string; createdAt: string } | null;
  }[];
  purchases: {
    student: StudentRef;
    courseId: number;
    amountPaid: number;
    country: string;
    createdAt: string;
  }[];
  team: {
    buyer: SeedUser;
    courseId: number;
    createdAt: string;
    amountPaid: number;
    country: string;
    couponCodes: string[];
    redemptions: { student: StudentRef; redeemedAt: string }[];
  } | null;
}

const FIRST_NAMES = [
  "Ava",
  "Noah",
  "Mia",
  "Ethan",
  "Zara",
  "Lucas",
  "Chloe",
  "Mateo",
  "Aisha",
  "Kenji",
];
const LAST_NAMES = ["Patel", "Novak", "Okafor", "Silva", "Lindqvist"];

const FULL_PRICE_COUNTRIES = ["US", "GB", "DE", "CA", "AU", "NL"];
// Regional (PPP) discounts: fraction of the full price actually paid.
const PPP_COUNTRIES: { country: string; factor: number }[] = [
  { country: "IN", factor: 0.5 },
  { country: "BR", factor: 0.6 },
  { country: "MX", factor: 0.6 },
  { country: "ID", factor: 0.5 },
  { country: "NG", factor: 0.4 },
  { country: "PH", factor: 0.5 },
];

const COMMENT_BODIES = [
  "Could you go over this part again? I lost the thread halfway through the example.",
  "Is there a reason to do it this way rather than the approach from the previous lesson?",
  "The example works for me, but I don't understand *why* it works. Any pointers?",
  "I'm getting a different result from the video. Has something changed since it was recorded?",
  "How would this look in a larger codebase? The example feels a bit small to generalise from.",
  "Great lesson — the diagram finally made this click for me.",
  "Is there a recommended exercise to practise this before moving on?",
  "What's the most common mistake people make with this?",
];

const REPLY_BODIES = [
  "Good question! The short version: the earlier approach works, but this one scales better once the codebase grows.",
  "Nothing has changed — double-check the version in your `package.json` against the one in the lesson repo.",
  "Try re-running the example step by step and log the intermediate values; it should become clear where it diverges.",
  "The exercise in the lesson repo covers exactly this. Give it a go and post back if you get stuck.",
];

/** Deterministic value in [0, 1) derived from the given keys. */
function unit(...keys: number[]): number {
  let h = 0x811c9dc5;
  for (const key of keys) {
    h ^= key;
    h = Math.imul(h, 0x01000193);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
  }
  return (h >>> 0) / 4294967296;
}

function pick<T>(items: T[], u: number): T {
  return items[Math.floor(u * items.length)];
}

export function planAnalyticsSeed({
  now,
  courses,
}: AnalyticsSeedInput): AnalyticsSeedPlan {
  const nowMs = now.getTime();
  const iso = (msAgo: number) => new Date(nowMs - msAgo).toISOString();

  const plan: AnalyticsSeedPlan = {
    students: [],
    enrollments: [],
    progress: [],
    quizAttempts: [],
    ratings: [],
    comments: [],
    purchases: [],
    team: null,
  };

  // Team seats are only sold for the first paid course; redemptions are
  // collected, then the team purchase is dated once the earliest is known.
  const teamCourse = courses.find((c) => c.price > 0);
  const teamRedemptions: { student: StudentRef; enrolledMsAgo: number }[] = [];

  for (let s = 0; s < STUDENT_COUNT; s++) {
    const first = FIRST_NAMES[s % FIRST_NAMES.length];
    const last = LAST_NAMES[Math.floor(s / FIRST_NAMES.length)];

    // Which courses this student takes. Everyone takes at least one.
    let chosen = courses.filter((_, ci) => unit(s, ci, 10) < 0.55);
    if (chosen.length === 0) chosen = [courses[s % courses.length]];

    let earliestEnrollMsAgo = 0;

    for (const course of chosen) {
      const ci = courses.indexOf(course);
      const n = course.lessonIds.length;

      // Skewed towards recent days so the enrollment trend grows over time.
      const enrolledDays = Math.floor(
        WINDOW_DAYS * (1 - Math.sqrt(unit(s, ci, 11)))
      );
      const enrolledMsAgo =
        enrolledDays * DAY_MS + Math.floor(unit(s, ci, 12) * DAY_MS * 0.9);
      earliestEnrollMsAgo = Math.max(earliestEnrollMsAgo, enrolledMsAgo);

      plan.enrollments.push({
        student: s,
        courseId: course.courseId,
        enrolledAt: iso(enrolledMsAgo),
      });

      // ── Lesson progress: completions are always a prefix of the course, so
      // completion per lesson falls off with lesson order.
      let completedCount: number;
      if (enrolledDays >= 7 && unit(s, ci, 20) < 0.22) {
        completedCount = n;
      } else {
        // u² piles students up on the early lessons.
        completedCount = Math.floor(n * unit(s, ci, 21) ** 2);
        // Recent enrollees haven't had time to get far.
        completedCount = Math.min(completedCount, enrolledDays * 2 + 1);
      }

      // Lessons are completed at an even pace across part of the time since enrolling.
      const span = 0.4 + 0.55 * unit(s, ci, 23);
      const completionMsAgo = (k: number) =>
        Math.floor(
          enrolledMsAgo * (1 - ((k + 1) / (completedCount + 1)) * span)
        );

      for (let k = 0; k < completedCount; k++) {
        plan.progress.push({
          student: s,
          lessonId: course.lessonIds[k],
          status: LessonProgressStatus.Completed,
          completedAt: iso(completionMsAgo(k)),
        });
      }
      if (completedCount < n && unit(s, ci, 22) < 0.6) {
        plan.progress.push({
          student: s,
          lessonId: course.lessonIds[completedCount],
          status: LessonProgressStatus.InProgress,
          completedAt: null,
        });
      }

      const lastActivityMsAgo =
        completedCount > 0
          ? completionMsAgo(completedCount - 1)
          : enrolledMsAgo;

      // ── Quiz attempts on quizzes attached to lessons the student completed.
      for (const quiz of course.quizzes) {
        const lessonIndex = course.lessonIds.indexOf(quiz.lessonId);
        if (lessonIndex < 0 || lessonIndex >= completedCount) continue;

        const q = quiz.questions.length;
        const attemptedMsAgo = completionMsAgo(lessonIndex);
        const correct = Math.min(
          q,
          Math.floor(unit(s, ci, quiz.quizId, 30) * (q + 1))
        );
        const attempt = buildAttempt(s, quiz, correct, iso(attemptedMsAgo));
        plan.quizAttempts.push(attempt);

        if (!attempt.passed && unit(s, ci, quiz.quizId, 31) < 0.7) {
          plan.quizAttempts.push(
            buildAttempt(s, quiz, q, iso(Math.floor(attemptedMsAgo * 0.9)))
          );
        }
      }

      // ── Ratings from students who got a few lessons in.
      if (completedCount >= Math.min(3, n) && unit(s, ci, 40) < 0.65) {
        const u = unit(s, ci, 41);
        const rating =
          completedCount === n
            ? pick([3, 4, 5, 5, 5], u)
            : pick([1, 2, 3, 3, 4, 4, 5], u);
        plan.ratings.push({
          student: s,
          courseId: course.courseId,
          rating,
          createdAt: iso(Math.floor(lastActivityMsAgo * 0.5)),
        });
      }

      // ── Comments on lessons the student completed. Live comments get an
      // instructor reply so they don't flood the instructor's Q&A queue.
      if (completedCount > 0) {
        const commentCount =
          unit(s, ci, 50) < 0.45 ? (unit(s, ci, 52) < 0.3 ? 2 : 1) : 0;
        for (let k = 0; k < commentCount; k++) {
          const lessonIndex = Math.floor(completedCount * unit(s, ci, k, 51));
          const createdMsAgo = Math.floor(completionMsAgo(lessonIndex) * 0.9);
          const deleted = unit(s, ci, k, 53) < 0.15;
          plan.comments.push({
            student: s,
            lessonId: course.lessonIds[lessonIndex],
            body: pick(COMMENT_BODIES, unit(s, ci, k, 54)),
            createdAt: iso(createdMsAgo),
            deletedAt: deleted ? iso(Math.floor(createdMsAgo * 0.95)) : null,
            reply: deleted
              ? null
              : {
                  authorId: course.instructorId,
                  body: pick(REPLY_BODIES, unit(s, ci, k, 55)),
                  createdAt: iso(Math.floor(createdMsAgo * 0.7)),
                },
          });
        }
      }

      // ── How the student got access: free (no purchase), a team seat, a
      // regional (PPP) discount, or full price.
      if (course.price === 0) continue;
      const u = unit(s, ci, 60);
      if (u < 0.1) continue; // free / comped — enrolled without a purchase
      if (course === teamCourse && u < 0.22) {
        teamRedemptions.push({ student: s, enrolledMsAgo });
        continue;
      }
      const { country, factor } =
        u < 0.45
          ? pick(PPP_COUNTRIES, unit(s, ci, 61))
          : { country: pick(FULL_PRICE_COUNTRIES, unit(s, ci, 62)), factor: 1 };
      plan.purchases.push({
        student: s,
        courseId: course.courseId,
        amountPaid: Math.round(course.price * factor),
        country,
        createdAt: iso(enrolledMsAgo),
      });
    }

    plan.students.push({
      name: `${first} ${last}`,
      email: `${first}.${last}@learner.dev`.toLowerCase(),
      avatarUrl:
        `https://api.dicebear.com/9.x/avataaars/svg?seed=${first}-${last}`.toLowerCase(),
      createdAt: iso(earliestEnrollMsAgo + DAY_MS),
    });
  }

  if (teamCourse && teamRedemptions.length > 0) {
    // Bought a day before the first seat was redeemed, with two seats spare.
    const purchasedMsAgo =
      Math.max(...teamRedemptions.map((r) => r.enrolledMsAgo)) + DAY_MS;
    const seats = teamRedemptions.length + 2;
    plan.team = {
      buyer: {
        name: "Priya Raman",
        email: "priya.raman@learner.dev",
        avatarUrl:
          "https://api.dicebear.com/9.x/avataaars/svg?seed=priya-raman",
        createdAt: iso(purchasedMsAgo + 5 * DAY_MS),
      },
      courseId: teamCourse.courseId,
      createdAt: iso(purchasedMsAgo),
      amountPaid: teamCourse.price * seats,
      country: "US",
      couponCodes: Array.from(
        { length: seats },
        (_, i) =>
          `TEAM-SEED-C${teamCourse.courseId}-${String(i + 1).padStart(3, "0")}`
      ),
      redemptions: teamRedemptions.map((r) => ({
        student: r.student,
        redeemedAt: iso(r.enrolledMsAgo),
      })),
    };
  }

  return plan;
}

function buildAttempt(
  student: StudentRef,
  quiz: AnalyticsSeedQuiz,
  correct: number,
  attemptedAt: string
): AnalyticsSeedPlan["quizAttempts"][number] {
  const score = correct / quiz.questions.length;
  return {
    student,
    quizId: quiz.quizId,
    score,
    passed: score >= quiz.passingScore,
    attemptedAt,
    answers: quiz.questions.map((question, qi) => ({
      questionId: question.questionId,
      selectedOptionId:
        qi < correct ? question.correctOptionId : question.wrongOptionId,
    })),
  };
}

// ─── Insertion ───

export function insertAnalyticsSeed(
  db: BetterSQLite3Database<typeof schema>,
  plan: AnalyticsSeedPlan
) {
  const studentIds = db
    .insert(schema.users)
    .values(plan.students.map((s) => ({ ...s, role: UserRole.Student })))
    .returning({ id: schema.users.id })
    .all()
    .map((row) => row.id);
  const id = (ref: StudentRef) => studentIds[ref];

  db.insert(schema.enrollments)
    .values(plan.enrollments.map((e) => ({ ...e, userId: id(e.student) })))
    .run();

  db.insert(schema.lessonProgress)
    .values(plan.progress.map((p) => ({ ...p, userId: id(p.student) })))
    .run();

  for (const attempt of plan.quizAttempts) {
    const [row] = db
      .insert(schema.quizAttempts)
      .values({ ...attempt, userId: id(attempt.student) })
      .returning()
      .all();
    db.insert(schema.quizAnswers)
      .values(attempt.answers.map((a) => ({ ...a, attemptId: row.id })))
      .run();
  }

  db.insert(schema.courseRatings)
    .values(
      plan.ratings.map((r) => ({
        ...r,
        userId: id(r.student),
        updatedAt: r.createdAt,
      }))
    )
    .run();

  for (const c of plan.comments) {
    const [row] = db
      .insert(schema.comments)
      .values({
        lessonId: c.lessonId,
        userId: id(c.student),
        body: c.body,
        createdAt: c.createdAt,
        deletedAt: c.deletedAt,
      })
      .returning()
      .all();
    if (c.reply) {
      db.insert(schema.comments)
        .values({
          lessonId: c.lessonId,
          userId: c.reply.authorId,
          parentId: row.id,
          body: c.reply.body,
          createdAt: c.reply.createdAt,
        })
        .run();
    }
  }

  db.insert(schema.purchases)
    .values(plan.purchases.map((p) => ({ ...p, userId: id(p.student) })))
    .run();

  if (plan.team) {
    const team = plan.team;
    const [buyer] = db
      .insert(schema.users)
      .values({ ...team.buyer, role: UserRole.Student })
      .returning()
      .all();
    const [teamRow] = db
      .insert(schema.teams)
      .values({ createdAt: team.createdAt })
      .returning()
      .all();
    db.insert(schema.teamMembers)
      .values({
        teamId: teamRow.id,
        userId: buyer.id,
        role: TeamMemberRole.Admin,
        createdAt: team.createdAt,
      })
      .run();
    const [purchase] = db
      .insert(schema.purchases)
      .values({
        userId: buyer.id,
        courseId: team.courseId,
        amountPaid: team.amountPaid,
        country: team.country,
        createdAt: team.createdAt,
      })
      .returning()
      .all();
    db.insert(schema.coupons)
      .values(
        team.couponCodes.map((code, i) => {
          const redemption = team.redemptions[i];
          return {
            teamId: teamRow.id,
            courseId: team.courseId,
            code,
            purchaseId: purchase.id,
            redeemedByUserId: redemption ? id(redemption.student) : null,
            redeemedAt: redemption ? redemption.redeemedAt : null,
            createdAt: team.createdAt,
          };
        })
      )
      .run();
  }

  return {
    students: plan.students.length + (plan.team ? 1 : 0),
    enrollments: plan.enrollments.length,
    progress: plan.progress.length,
    quizAttempts: plan.quizAttempts.length,
    ratings: plan.ratings.length,
    comments: plan.comments.length,
    purchases: plan.purchases.length + (plan.team ? 1 : 0),
    teams: plan.team ? 1 : 0,
    couponsRedeemed: plan.team?.redemptions.length ?? 0,
  };
}
