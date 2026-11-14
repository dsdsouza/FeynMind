// The knowledge module: syllabus parsing, page transcription, concept extraction, merging,
// prerequisite links and the review screen's edits. Other modules use only what is exported here.
export { KnowledgeService, type KnowledgeIngestion, type KnowledgeProviders, type KnowledgeServiceOptions, type UnitGraph } from './service'
export { PromptLibrary, renderPrompt, type PromptFile } from './prompts'
export { damped, textTokens } from './tasks'
