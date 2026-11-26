// Every Forge function handler, by the name the manifest refers to.

export { processIntake } from './intake/consumer.js';
export { handleIntake } from './intake/webtrigger.js';
export { validateSubmit } from './validator/submit.js';
export { adminHandler } from './resolvers/admin.js';
export { panelHandler } from './resolvers/panel.js';
export { evaluateRubric, getDisputeContext } from './actions/index.js';
export { onLifecycle } from './lifecycle.js';
