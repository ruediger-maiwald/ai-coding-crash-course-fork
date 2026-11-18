import { asc, count, eq, getTableColumns } from "drizzle-orm";
import { db } from "~/db";
import { courses, enrollments, lessons, modules } from "~/db/schema";

/**
 * Every course owned by the instructor (any status), with its lesson and
 * student counts. One grouped query, rather than two count queries per course.
 */
export function getInstructorCourseStats(instructorId: number) {
  const lessonCounts = db
    .select({
      courseId: modules.courseId,
      lessonCount: count(lessons.id).as("lesson_count"),
    })
    .from(modules)
    .innerJoin(lessons, eq(lessons.moduleId, modules.id))
    .groupBy(modules.courseId)
    .as("lesson_counts");

  const enrollmentCounts = db
    .select({
      courseId: enrollments.courseId,
      enrollmentCount: count(enrollments.id).as("enrollment_count"),
    })
    .from(enrollments)
    .groupBy(enrollments.courseId)
    .as("enrollment_counts");

  const rows = db
    .select({
      ...getTableColumns(courses),
      lessonCount: lessonCounts.lessonCount,
      enrollmentCount: enrollmentCounts.enrollmentCount,
    })
    .from(courses)
    .leftJoin(lessonCounts, eq(lessonCounts.courseId, courses.id))
    .leftJoin(enrollmentCounts, eq(enrollmentCounts.courseId, courses.id))
    .where(eq(courses.instructorId, instructorId))
    .orderBy(asc(courses.id))
    .all();

  // A course with no lessons or enrollments has no row in the grouped
  // subquery, so the left join yields null.
  return rows.map((row) => ({
    ...row,
    lessonCount: row.lessonCount ?? 0,
    enrollmentCount: row.enrollmentCount ?? 0,
  }));
}
