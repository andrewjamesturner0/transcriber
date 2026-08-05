// Pure model chooser helpers. Model facts always come from the IPC catalogue.
(function initModelChooser(root) {
  const TASKS = Object.freeze([
    { id: 'general-purpose', label: 'General purpose', modelId: 'small' },
    { id: 'fast-english', label: 'Fast English', modelId: 'parakeet-tdt-ctc-110m' },
    { id: 'small-download', label: 'Small download', modelId: 'moonshine-tiny' },
    { id: 'multilingual', label: 'Multilingual', modelId: 'nemotron-3.5-0.6b' },
    { id: 'translation', label: 'Translation', modelId: 'large-v3' },
    { id: 'accuracy-first', label: 'Accuracy first', modelId: 'large-v3' },
  ]);

  function suggestions(models) {
    return TASKS.map((task) => ({ task, model: models.find((model) => model.id === task.modelId) }))
      .filter((entry) => entry.model);
  }

  function orderedModels(models) {
    const suggestedIds = [...new Set(TASKS.map((task) => task.modelId))];
    return [
      ...suggestedIds.map((id) => models.find((model) => model.id === id)).filter(Boolean),
      ...models.filter((model) => !suggestedIds.includes(model.id)),
    ];
  }

  function filterModels(models, query) {
    const needle = query.trim().toLowerCase();
    if (!needle) return models;
    return models.filter((model) => [
      model.displayName,
      model.practicalDescription,
      model.size,
      ...(model.languages || []),
    ].some((value) => String(value || '').toLowerCase().includes(needle)));
  }

  function taskLabel(taskId) {
    return TASKS.find((task) => task.id === taskId)?.label || 'More models';
  }

  function defaultTaskId(model) {
    if (!model) return null;
    const matchingTasks = TASKS.filter((task) => task.modelId === model.id);
    return matchingTasks.find((task) => task.id === model.task)?.id
      || matchingTasks[0]?.id
      || null;
  }

  root.modelChooser = {
    TASKS,
    suggestions,
    orderedModels,
    filterModels,
    taskLabel,
    defaultTaskId,
  };
}(window));
