import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import { getInstructorCourseStats } from "./analyticsService";

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
  for (let i = 1; i <= count; i++) {
    testDb
      .insert(schema.lessons)
      .values({ moduleId, title: `Lesson ${i}`, position: i })
      .run();
  }
}

function enroll(userId: number, courseId: number) {
  testDb.insert(schema.enrollments).values({ userId, courseId }).run();
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
