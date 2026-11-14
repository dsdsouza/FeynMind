// The tutor module: the diagnostic, standings and the next concept, lessons with grounded
// explanations, rubric grading and contests. Other modules use only what is exported here.
export { TutorService, type TutorProviders, type TutorServiceOptions } from './service'
export { verdictOf, type Criterion, type CriterionResult, type Verdict } from './schemas'
