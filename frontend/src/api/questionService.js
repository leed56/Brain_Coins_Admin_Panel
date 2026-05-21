/**
 * FRONTEND - Question API Service
 * Handles API calls to backend for question generation
 */

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

const normalizeQuestionType = (type) => {
  const normalized = String(type || 'MCQ').trim().toUpperCase();
  return normalized === 'FIB' ? 'FIIB' : normalized;
};

const normalizeCounts = (counts = {}) => {
  return Object.entries(counts || {}).reduce((acc, [key, value]) => {
    const type = normalizeQuestionType(key);
    const count = parseInt(value, 10);
    acc[type] = Math.max(0, Number.isNaN(count) ? 0 : count);
    return acc;
  }, {});
};

// Helper: Normalize question to UI shape
const normalizeQuestion = (q) => ({
  ...q,
  id: q.id,
  type: normalizeQuestionType(q.type || q.question_type || 'MCQ'),
  question: q.question || q.question_text || q.question_text_si || q.question_text_ta || '',
  answer: q.answer || q.correct_answer || '',
  options: Array.isArray(q.options) ? q.options : [],
  pairs: Array.isArray(q.pairs) ? q.pairs : [],
  diagram: q.diagram || undefined,
  reasoning: q.reasoning || undefined,
  explanations: q.explanations || q.explanation || q.explanation_si || q.explanation_ta || '',
  language: q.language || 'English',
  generated: q.generated !== undefined ? q.generated : true
});

export const generateQuestionsFromFile = async (fileUrl, fileType, options = {}) => {
  try {
    const {
      pack_id,
      count = 5,
      difficulty = 'Intermediate',
      types = ['MCQ', 'FIIB', 'TF', 'HOQ', 'MATCH', 'DIAGRAM', 'IMAGE_MCQ'],
      language = 'English',
      bloom_level = 'Understand'
    } = options;

    if (!pack_id) {
      throw new Error('Please select a learning pack');
    }

    const response = await fetch(`${API_BASE_URL}/questions/generate-from-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        fileUrl,
        fileType,
        pack_id,
        count,
        difficulty,
        types: Array.isArray(types) ? types.map(normalizeQuestionType) : ['MCQ', 'FIIB', 'TF', 'HOQ'],
        language,
        bloom_level
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'Failed to generate questions');
    }

    const data = await response.json();
    const normalized = (data.questions || []).map(normalizeQuestion);

    return {
      questions: normalized,
      summary_bullets: Array.isArray(data.summary_bullets) ? data.summary_bullets : []
    };
  } catch (error) {
    console.error('[Frontend API] Generate questions error:', error);
    throw error;
  }
};

export const getSummaryByPack = async (pack_id) => {
  try {
    const res = await fetch(`${API_BASE_URL}/questions/summaries/${pack_id}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to fetch summary');
    }
    const data = await res.json();
    const bullets = data?.data?.bullets || [];
    return Array.isArray(bullets) ? bullets : [];
  } catch (e) {
    console.error('[Frontend API] Get summary error:', e);
    throw e;
  }
};

export const upsertSummaryByPack = async (pack_id, bullets) => {
  try {
    const res = await fetch(`${API_BASE_URL}/questions/summaries/${pack_id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bullets })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to save summary');
    }
    const data = await res.json();
    const bulletsOut = data?.data?.bullets || bullets || [];
    return Array.isArray(bulletsOut) ? bulletsOut : [];
  } catch (e) {
    console.error('[Frontend API] Upsert summary error:', e);
    throw e;
  }
};

export const createQuestion = async (payload) => {
  try {
    const response = await fetch(`${API_BASE_URL}/questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, type: normalizeQuestionType(payload?.type) })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'Failed to create question');
    }

    const data = await response.json();
    return normalizeQuestion({ ...data.question, generated: false });
  } catch (error) {
    console.error('[Frontend API] Create question error:', error);
    throw error;
  }
};

export const generateQuestionsFromText = async (content, options = {}) => {
  try {
    const {
      count = 5,
      difficulty = 'Intermediate',
      types = ['MCQ', 'FIIB', 'TF', 'HOQ', 'Summary']
    } = options;

    const response = await fetch(`${API_BASE_URL}/questions/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        count,
        difficulty,
        types: Array.isArray(types) ? types.map(normalizeQuestionType) : ['MCQ']
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'Failed to generate questions');
    }

    const data = await response.json();
    return (data.questions || []).map(normalizeQuestion);
  } catch (error) {
    console.error('[Frontend API] Generate questions error:', error);
    throw error;
  }
};

export const updateQuestion = async (questionId, updates) => {
  try {
    const payload = { ...updates };
    if (payload.type) payload.type = normalizeQuestionType(payload.type);

    const response = await fetch(`${API_BASE_URL}/questions/${questionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'Failed to update question');
    }

    const data = await response.json();
    return normalizeQuestion(data.question);
  } catch (error) {
    console.error('[Frontend API] Update question error:', error);
    throw error;
  }
};

export const updateQuestionDifficulty = async (questionId, difficulty) => {
  try {
    const response = await fetch(`${API_BASE_URL}/questions/${questionId}/difficulty`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ difficulty })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'Failed to update difficulty');
    }

    const data = await response.json();
    return normalizeQuestion(data.question);
  } catch (error) {
    console.error('[Frontend API] Update difficulty error:', error);
    throw error;
  }
};

export const deleteQuestion = async (questionId) => {
  try {
    const response = await fetch(`${API_BASE_URL}/questions/${questionId}`, { method: 'DELETE' });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'Failed to delete question');
    }
  } catch (error) {
    console.error('[Frontend API] Delete question error:', error);
    throw error;
  }
};

export const previewFromFile = async (fileUrl, fileType, options = {}) => {
  const counts = normalizeCounts(options.questionTypes || options.counts || {});

  const payload = {
    fileUrl,
    fileType,
    language: options.language,
    grade: options.grade,
    subject: options.subject,
    counts,
    difficulty: options.difficulty,
    typeDifficulties: options.typeDifficulties || {},
    types: Object.keys(counts).filter(k => counts[k] > 0),
    bloom_level: options.bloom_level,
    generationStyle: options.generationStyle || 'Exam Paper Style',
    packTitle: options.packTitle || '',
    packDescription: options.packDescription || ''
  };

  const res = await fetch(`${API_BASE_URL}/questions/preview-from-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to generate preview');
  }
  const data = await res.json();
  const pv = data?.preview || {};
  const normalizedQuestions = Array.isArray(pv.questions) ? pv.questions.map(normalizeQuestion) : [];
  return {
    detected_metadata: pv.detected_metadata || {},
    summary_bullets: Array.isArray(pv.summary_bullets) ? pv.summary_bullets : [],
    counts: pv.counts || {},
    totals: pv.totals || {},
    questions: normalizedQuestions
  };
};

export const approveFromPreview = async ({ pack_id, questions, summary_bullets, language, difficulty, bloom_level }) => {
  const normalizedQuestions = Array.isArray(questions)
    ? questions.map(q => ({ ...q, type: normalizeQuestionType(q.type || q.question_type) }))
    : [];

  const res = await fetch(`${API_BASE_URL}/questions/approve-from-preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ pack_id, questions: normalizedQuestions, summary_bullets, language, difficulty, bloom_level })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to approve items');
  }
  const data = await res.json();
  const normalized = (data.questions || []).map(normalizeQuestion);
  return { questions: normalized, saved_summary: data.saved_summary, count: data.count, pack_id: data.pack_id };
};

export default {
  generateQuestionsFromFile,
  generateQuestionsFromText,
  updateQuestion,
  updateQuestionDifficulty,
  deleteQuestion
};
