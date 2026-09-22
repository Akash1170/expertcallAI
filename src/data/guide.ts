export const guideQuestions = [
  'How would you describe current adoption of robotic surgery in your market?',
  'What are the main barriers to adoption?',
  'How important are hospital budgets and ROI in purchasing decisions?',
  'How important are surgeon training and clinical outcomes?',
  'What adoption trend do you expect over the next 3–5 years?',
  'What is the typical hospital decision-making timeline for purchasing a new robotic system?',
] as const;

export type GuideQuestion = typeof guideQuestions[number];
