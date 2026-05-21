import { generateQuestions, generateQuestionsFromFile, generateSummaryFromFile } from '../services/geminiService.js';
import {
  saveQuestions,
  getAllQuestions,
  updateQuestion,
  deleteQuestion,
  updateQuestionDifficulty,
  getSummaryByPack,
  upsertSummaryByPack
} from '../services/supabaseService.js';
import { getLearningPackWithSubject, createLearningPack } from '../services/learningPackService.js';

const ALLOWED_TYPES = ['MCQ', 'FIIB', 'TF', 'HOQ'];

const normalizeQuestionType = (type) => {
  const normalized = String(type || 'MCQ').trim().toUpperCase();
  return normalized === 'FIB' ? 'FIIB' : normalized;
};

const normalizeCounts = (countsObj = {}) => {
  const normalizedCounts = { MCQ: 0, FIIB: 0, TF: 0, HOQ: 0 };

  Object.entries(countsObj || {}).forEach(([rawType, rawCount]) => {
    const type = normalizeQuestionType(rawType);
    if (!ALLOWED_TYPES.includes(type)) return;
    const count = parseInt(rawCount, 10);
    normalizedCounts[type] = Math.max(0, Number.isNaN(count) ? 0 : count);
  });

  return normalizedCounts;
};

const getRequestedTypes = (normalizedCounts, types = []) => {
  const fromCounts = ALLOWED_TYPES.filter(type => normalizedCounts[type] > 0);
  if (fromCounts.length) return fromCounts;

  const fromTypes = Array.isArray(types)
    ? types.map(normalizeQuestionType).filter(type => ALLOWED_TYPES.includes(type))
    : [];

  return fromTypes.length ? [...new Set(fromTypes)] : ALLOWED_TYPES;
};

const buildQuestionSavePayload = ({ q, index, pack_id, language, difficulty, bloom_level, fallbackDifficulty }) => {
  const explanationText = q.explanation || q.reasoning || q.explanations || '';
  const questionText = q.question || q.question_text || `Question ${index + 1}`;
  const languageFields = mapLanguageFields(language, questionText, explanationText);

  return {
    pack_id,
    question_type: normalizeQuestionType(q.type || q.question_type || 'MCQ'),
    options: Array.isArray(q.options) ? q.options : [],
    correct_answer: q.answer || q.correct_answer || '',
    has_diagram: false,
    diagram_path: null,
    blooms_taxonomy: q.blooms_taxonomy || q.bloom || bloom_level || 'Understand',
    display_order: index + 1,
    difficulty: q.difficulty || difficulty || fallbackDifficulty || 'Medium',
    generated: true,
    metadata: q.metadata || {},
    ...languageFields
  };
};

// Helper: Map language-specific fields
const mapLanguageFields = (language, questionText, explanationText) => {
  return {
    question_text: questionText,
    question_text_si: language === 'Sinhala' ? questionText : null,
    question_text_ta: language === 'Tamil' ? questionText : null,
    explanation: explanationText,
    explanation_si: language === 'Sinhala' ? explanationText : null,
    explanation_ta: language === 'Tamil' ? explanationText : null
  };
};

// POST /api/questions/generate - Generate questions from text content
export const generateQuestionsHandler = async (req, res) => {
  try {
    const { content, count, pack_id, difficulty, type } = req.body;

    if (!content || !pack_id) {
      return res.status(400).json({ success: false, error: 'Content and pack_id are required' });
    }

    const safeCount = Math.min(Math.max(parseInt(count, 10) || 5, 1), 50);

    const questions = await generateQuestions(content, {
      count: safeCount,
      difficulty: difficulty || 'Medium',
      type: normalizeQuestionType(type || 'MCQ')
    });

    const questionsToSave = questions.map((q, index) => buildQuestionSavePayload({
      q,
      index,
      pack_id,
      language: req.body.language || 'English',
      difficulty,
      bloom_level: req.body.bloom_level || 'Remember',
      fallbackDifficulty: 'Medium'
    }));

    const savedQuestions = await saveQuestions(questionsToSave);
    res.json({ success: true, questions: savedQuestions, count: savedQuestions.length, requested: safeCount });

  } catch (error) {
    console.error('[Backend] Generate questions error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to generate questions' });
  }
};

// POST /api/questions - Create single manual question
export const createQuestionHandler = async (req, res) => {
  try {
    const {
      pack_id, type = 'MCQ', difficulty = 'Medium', question = '', answer = '',
      options = [], language = 'English', blooms_taxonomy = 'Understand'
    } = req.body || {};

    if (!pack_id || !question) {
      return res.status(400).json({ success: false, error: 'pack_id and question are required' });
    }

    const base = {
      pack_id,
      question_type: normalizeQuestionType(type),
      options: Array.isArray(options) ? options : [],
      correct_answer: answer,
      explanation: req.body.explanation || '',
      has_diagram: false,
      diagram_path: null,
      blooms_taxonomy,
      display_order: req.body.display_order || 0,
      difficulty,
      generated: false
    };

    const languageFields = mapLanguageFields(language, question, req.body.explanation || '');
    const [saved] = await saveQuestions([{ ...base, ...languageFields }]);

    if (!saved) {
      return res.status(409).json({ success: false, error: 'Duplicate question skipped. This question already exists in the selected learning pack.' });
    }

    return res.status(201).json({ success: true, question: saved });
  } catch (error) {
    console.error('[Backend] Create question error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to create question' });
  }
};

// POST /api/questions/preview-from-file - Generate preview without saving
export const generatePreviewFromFileHandler = async (req, res) => {
  try {
    const {
      fileUrl, fileType, language, grade, subject, counts, difficulty,
      bloom_level, typeDifficulties, packTitle, packDescription, generationStyle
    } = req.body || {};

    if (!fileUrl || !fileType) {
      return res.status(400).json({ success: false, error: 'fileUrl and fileType are required' });
    }

    const normalizedCounts = normalizeCounts(counts || req.body.questionTypes || {});
    const requestedTypes = getRequestedTypes(normalizedCounts, req.body.types);
    const totalRequested = requestedTypes.reduce((sum, type) => sum + (normalizedCounts[type] || 0), 0);

    if (totalRequested <= 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one question type with count greater than 0 is required'
      });
    }

    console.log('[Preview] Generating questions with params:', {
      fileType,
      totalRequested,
      difficulty,
      requestedTypes,
      language,
      generationStyle: generationStyle || 'Exam Paper Style'
    });

    let gen;
    try {
      gen = await generateQuestionsFromFile(fileUrl, fileType, {
        count: totalRequested,
        difficulty: difficulty || 'Medium',
        types: requestedTypes,
        counts: normalizedCounts,
        language: language || 'English',
        grade: grade || 'Unknown',
        subject: subject || 'Unknown',
        bloom_level: bloom_level || 'Understand',
        generationStyle: generationStyle || 'Exam Paper Style',
        packTitle: packTitle || '',
        packDescription: packDescription || ''
      });
    } catch (genError) {
      console.error('[Preview] Error from generateQuestionsFromFile:', genError);
      return res.status(500).json({
        success: false,
        error: `Question generation failed: ${genError.message}. Please check your file, Gemini key, and generation settings.`
      });
    }

    if (!Array.isArray(gen) || gen.length === 0) {
      return res.status(500).json({
        success: false,
        error: 'No questions were generated from the file. The content may be too short, unclear, or the selected learning pack may not match the file.'
      });
    }

    const questionsByType = { MCQ: [], FIIB: [], TF: [], HOQ: [] };
    gen.forEach(q => {
      const type = normalizeQuestionType(q.type || q.question_type || 'MCQ');
      if (questionsByType[type]) questionsByType[type].push({ ...q, type });
    });

    const selected = [];
    for (const type of requestedTypes) {
      const available = questionsByType[type] || [];
      const typeDifficulty = (typeDifficulties && typeDifficulties[type]) || difficulty || 'Medium';
      const countToTake = Math.min(available.length, normalizedCounts[type]);
      selected.push(...available.slice(0, countToTake).map(q => ({ ...q, difficulty: typeDifficulty })));
    }

    const summary_bullets = await generateSummaryFromFile(fileUrl, fileType, language || 'English', packTitle, packDescription);

    return res.json({
      success: true,
      preview: {
        detected_metadata: { language: language || 'English', grade: grade || 'Unknown', subject: subject || 'Unknown', topics: [] },
        summary_bullets,
        counts: normalizedCounts,
        totals: { requested: totalRequested, generated: gen.length, selected: selected.length },
        questions: selected
      }
    });
  } catch (error) {
    console.error('[Backend] Preview from file error:', error);
    return res.status(500).json({ success: false, error: error.message || 'Failed to generate preview' });
  }
};

// POST /api/questions/generate-from-file - Generate and save questions from file
export const generateQuestionsFromFileHandler = async (req, res) => {
  try {
    const {
      fileUrl, fileType, pack_id, count, counts, difficulty,
      types, language, bloom_level, generationStyle
    } = req.body;

    if (!fileUrl || !fileType) {
      return res.status(400).json({ success: false, error: 'fileUrl and fileType are required' });
    }

    let effectivePackId = pack_id;
    let learningPack;

    if (!effectivePackId) {
      const { subject_id, grade, pack_title, pack_description, pack_difficulty } = req.body;

      if (!subject_id || !grade) {
        return res.status(400).json({
          success: false,
          error: 'Either pack_id must be provided, or subject_id and grade are required'
        });
      }

      const createdPack = await createLearningPack({
        subject_id,
        grade,
        title: pack_title || `Auto Pack - ${new Date().toLocaleDateString()}`,
        description: pack_description || 'Auto-created for AI question generation',
        difficulty: pack_difficulty || difficulty || 'Medium',
        is_active: true
      });

      effectivePackId = createdPack.id;
      learningPack = await getLearningPackWithSubject(effectivePackId);
    } else {
      learningPack = await getLearningPackWithSubject(effectivePackId);
      if (!learningPack) {
        return res.status(404).json({ success: false, error: 'Learning pack not found' });
      }
    }

    const normalizedCounts = normalizeCounts(counts || req.body.questionTypes || {});
    const hasPerTypeCounts = Object.values(normalizedCounts).some(v => v > 0);
    const filteredTypes = getRequestedTypes(normalizedCounts, types);
    const totalRequested = hasPerTypeCounts
      ? filteredTypes.reduce((sum, type) => sum + (normalizedCounts[type] || 0), 0)
      : Math.min(Math.max(parseInt(count, 10) || 5, 1), 50);

    const questions = await generateQuestionsFromFile(fileUrl, fileType, {
      count: totalRequested,
      counts: hasPerTypeCounts ? normalizedCounts : undefined,
      difficulty: difficulty || learningPack.difficulty || 'Medium',
      types: filteredTypes.length ? filteredTypes : ALLOWED_TYPES,
      language,
      bloom_level,
      generationStyle: generationStyle || 'Exam Paper Style',
      packTitle: learningPack?.title || '',
      packDescription: learningPack?.description || ''
    });

    const questionsToSave = questions.map((q, idx) => buildQuestionSavePayload({
      q,
      index: idx,
      pack_id: effectivePackId,
      language,
      difficulty,
      bloom_level,
      fallbackDifficulty: learningPack.difficulty || 'Medium'
    }));

    const savedQuestions = await saveQuestions(questionsToSave);

    const packTitle = learningPack?.title || '';
    const packDescription = learningPack?.description || '';
    const summary_bullets = await generateSummaryFromFile(fileUrl, fileType, language || 'English', packTitle, packDescription);

    let saved_summary = null;
    if (Array.isArray(summary_bullets) && summary_bullets.length) {
      try {
        saved_summary = await upsertSummaryByPack(effectivePackId, summary_bullets);
      } catch (e) {
        console.error('[Backend] Persist summary error:', e);
      }
    }

    res.json({
      success: true,
      questions: savedQuestions,
      summary_bullets,
      saved_summary,
      count: savedQuestions.length,
      requested: totalRequested,
      skipped_duplicates: questionsToSave.length - savedQuestions.length,
      pack_id: effectivePackId,
      subject_id: learningPack.subject_id,
      source: 'file',
      fileType
    });

  } catch (error) {
    console.error('[Backend] Generate from file error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to generate questions from file' });
  }
};

// GET /api/questions - Get all questions with filters
export const getAllQuestionsHandler = async (req, res) => {
  try {
    const { pack_id, subject_id, type, difficulty, page = 1, limit = 20 } = req.query;

    const { data: questions, count } = await getAllQuestions({
      pack_id,
      subject_id,
      type: type ? normalizeQuestionType(type) : undefined,
      difficulty,
      page: parseInt(page),
      limit: Math.min(parseInt(limit), 100)
    });

    res.json({
      success: true,
      data: questions,
      pagination: {
        page: parseInt(page),
        limit: Math.min(parseInt(limit), 100),
        total: count,
        pages: Math.ceil(count / Math.min(parseInt(limit), 100))
      }
    });
  } catch (error) {
    console.error('[Backend] Get questions error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// PATCH /api/questions/:id - Update entire question
export const updateQuestionHandler = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      id: _ignore,
      created_at,
      pack_id,
      question: uiQuestion,
      answer: uiAnswer,
      type: uiType,
      language,
      explanation,
      ...rest
    } = req.body;

    let mappedUpdates = {
      ...rest,
      ...(uiQuestion && { question_text: uiQuestion }),
      ...(uiAnswer && { correct_answer: uiAnswer }),
      ...(uiType && { question_type: normalizeQuestionType(uiType) })
    };

    if (language && (uiQuestion || explanation)) {
      const languageFields = mapLanguageFields(
        language,
        uiQuestion || '',
        explanation || ''
      );
      mappedUpdates = { ...mappedUpdates, ...languageFields };
    } else if (explanation) {
      mappedUpdates.explanation = explanation;
    }

    const updatedQuestion = await updateQuestion(id, mappedUpdates);
    res.json({ success: true, question: updatedQuestion });
  } catch (error) {
    console.error(`[Backend] Update question ${req.params.id} error:`, error);
    res.status(500).json({ success: false, error: error.message || 'Failed to update question' });
  }
};

// PATCH /api/questions/:id/difficulty - Update difficulty only
export const updateQuestionDifficultyHandler = async (req, res) => {
  try {
    const { id } = req.params;
    const { difficulty } = req.body;

    if (!difficulty) {
      return res.status(400).json({ success: false, error: 'Difficulty is required' });
    }

    const updatedQuestion = await updateQuestionDifficulty(id, difficulty);
    res.json({ success: true, question: updatedQuestion });
  } catch (error) {
    console.error('[Backend] Update difficulty error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to update difficulty' });
  }
};

// DELETE /api/questions/:id - Delete question
export const deleteQuestionHandler = async (req, res) => {
  try {
    const { id } = req.params;
    await deleteQuestion(id);
    res.json({ success: true, message: 'Question deleted successfully' });
  } catch (error) {
    console.error('[Backend] Delete question error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to delete question' });
  }
};

// GET /api/summaries/:pack_id - Get summary by pack
export const getSummaryByPackHandler = async (req, res) => {
  try {
    const { pack_id } = req.params;
    if (!pack_id) return res.status(400).json({ success: false, error: 'pack_id is required' });
    const data = await getSummaryByPack(pack_id);
    res.json({ success: true, data: data || { pack_id, bullets: [] } });
  } catch (error) {
    console.error('[Backend] Get summary error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch summary' });
  }
};

// PUT /api/summaries/:pack_id - Upsert summary
export const upsertSummaryByPackHandler = async (req, res) => {
  try {
    const { pack_id } = req.params;
    const { bullets } = req.body || {};
    if (!pack_id) return res.status(400).json({ success: false, error: 'pack_id is required' });
    if (!Array.isArray(bullets)) {
      return res.status(400).json({ success: false, error: 'bullets must be an array of strings' });
    }
    const normalized = bullets.map(b => (typeof b === 'string' ? b.trim() : '')).filter(Boolean).slice(0, 20);
    const data = await upsertSummaryByPack(pack_id, normalized);
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Backend] Upsert summary error:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to save summary' });
  }
};

// POST /api/questions/approve-from-preview - Save previewed questions
export const approveFromPreviewHandler = async (req, res) => {
  try {
    const { pack_id, questions, summary, summary_bullets, language, difficulty, bloom_level } = req.body;
    const summaryToSave = summary || summary_bullets;

    if (!pack_id) {
      return res.status(400).json({ success: false, error: 'pack_id is required' });
    }

    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ success: false, error: 'questions array is required and must not be empty' });
    }

    const questionsToSave = questions.map((q, index) => buildQuestionSavePayload({
      q,
      index,
      pack_id,
      language,
      difficulty,
      bloom_level,
      fallbackDifficulty: 'Medium'
    }));

    const savedQuestions = await saveQuestions(questionsToSave);

    if (summaryToSave && Array.isArray(summaryToSave) && summaryToSave.length > 0) {
      await upsertSummaryByPack(pack_id, summaryToSave);
    }

    const response = {
      success: true,
      questions: savedQuestions,
      count: savedQuestions.length,
      skipped_duplicates: questionsToSave.length - savedQuestions.length,
      pack_id
    };

    if (summaryToSave && Array.isArray(summaryToSave) && summaryToSave.length > 0) {
      response.saved_summary = { bullets: summaryToSave, pack_id };
    }

    res.status(201).json(response);
  } catch (error) {
    console.error('[Backend] Approve from preview error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to approve questions',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
};

// POST /api/questions/:id/diagram - Upload diagram for question
export const uploadQuestionDiagramHandler = async (req, res) => {
  const multer = (await import('multer')).default;
  const { uploadQuestionDiagram } = await import('../services/questionDiagramService.js');

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/svg+xml', 'image/webp', 'image/bmp'];
      if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error('Invalid file type. Only images are allowed.'));
      }
    }
  });

  upload.single('diagram')(req, res, async (err) => {
    try {
      if (err) {
        return res.status(400).json({ success: false, error: err.message });
      }

      if (!req.file) {
        return res.status(400).json({ success: false, error: 'No file uploaded' });
      }

      const { id: questionId } = req.params;

      const result = await uploadQuestionDiagram(
        questionId,
        req.file.buffer,
        req.file.originalname
      );

      res.json({
        success: true,
        data: result
      });

    } catch (error) {
      console.error('[Backend] Upload diagram error:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to upload diagram'
      });
    }
  });
};

// DELETE /api/questions/:id/diagram - Remove diagram from question
export const deleteQuestionDiagramHandler = async (req, res) => {
  try {
    const { removeQuestionDiagram } = await import('../services/questionDiagramService.js');
    const { id: questionId } = req.params;

    await removeQuestionDiagram(questionId);

    res.json({
      success: true,
      message: 'Diagram removed successfully'
    });

  } catch (error) {
    console.error('[Backend] Delete diagram error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete diagram'
    });
  }
};