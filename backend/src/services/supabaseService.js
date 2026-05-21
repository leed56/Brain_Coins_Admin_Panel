/**
 * BACKEND - Supabase Service
 * This file contains server-side Supabase operations
 * Used by backend API controllers
 * DO NOT use this in frontend - use frontend/src/lib/supabaseClient.js instead
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const normalizeQuestionType = (type) => {
  const normalized = String(type || 'MCQ').trim().toUpperCase();
  return normalized === 'FIB' ? 'FIIB' : normalized;
};

const normalizeQuestionText = (text) => String(text || '').replace(/\s+/g, ' ').trim();

// Supabase Configuration (Backend - Server Side)
const supabaseUrl = process.env.SUPABASE_URL || ""; // require explicit .env
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ""; // require service role for server

// Diagnostics to help detect misconfiguration early
(() => {
  const maskedKey = supabaseServiceKey ? `${supabaseServiceKey.slice(0, 6)}...${supabaseServiceKey.slice(-4)}` : '(missing)';
  console.log('[Backend DB] Supabase URL:', supabaseUrl || '(missing)');
  console.log('[Backend DB] Supabase SERVICE ROLE KEY:', maskedKey);
  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('[Backend DB] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in backend .env');
  }
})();

// Initialize Supabase client for backend (with service role key for admin operations)
if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Supabase is not configured. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend .env');
}

export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

/**
 * Get all students from database
 * @returns {Promise<Array>} - List of students
 */
export const getAllStudents = async () => {
  try {
    const { data, error } = await supabaseAdmin
      .from('students')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('[Backend] Get students error:', error);
    throw error;
  }
};

/**
 * Get student by ID
 * @param {string} studentId - Student ID
 * @returns {Promise<Object>} - Student data
 */
export const getStudentById = async (studentId) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('students')
      .select('*')
      .eq('id', studentId)
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('[Backend] Get student error:', error);
    throw error;
  }
};

/**
 * Create new student
 * @param {Object} studentData - Student information
 * @returns {Promise<Object>} - Created student
 */
export const createStudent = async (studentData) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('students')
      .insert([studentData])
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('[Backend] Create student error:', error);
    throw error;
  }
};

/**
 * Update student
 * @param {string} studentId - Student ID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} - Updated student
 */
export const updateStudent = async (studentId, updates) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('students')
      .update(updates)
      .eq('id', studentId)
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('[Backend] Update student error:', error);
    throw error;
  }
};

/**
 * Delete student
 * @param {string} studentId - Student ID
 * @returns {Promise<void>}
 */
export const deleteStudent = async (studentId) => {
  try {
    const { error } = await supabaseAdmin
      .from('students')
      .delete()
      .eq('id', studentId);

    if (error) throw error;
  } catch (error) {
    console.error('[Backend] Delete student error:', error);
    throw error;
  }
};

/**
 * Save questions to database with the new schema
 * @param {Array} questions - Array of question objects
 * @returns {Promise<Array>} - Saved questions with IDs
 */
export const saveQuestions = async (questions) => {
  try {
    // Prepare questions for database with your schema
    const prepared = questions.map(q => ({
      pack_id: q.pack_id,
      question_text: normalizeQuestionText(q.question_text || q.question || ''), // ALWAYS set question_text
      question_text_si: q.question_text_si || null,
      question_text_ta: q.question_text_ta || null,
      question_type: normalizeQuestionType(q.question_type || q.type || 'MCQ'),
      options: Array.isArray(q.options) ? q.options : [],
      correct_answer: q.correct_answer || q.answer || '',
      explanation: q.explanation || '',
      explanation_si: q.explanation_si || null,
      explanation_ta: q.explanation_ta || null,
      has_diagram: q.has_diagram || !!q.diagram || false,
      diagram_path: q.diagram_path || null,
      blooms_taxonomy: q.blooms_taxonomy || 'Remember',
      display_order: q.display_order || 0,
      difficulty: q.difficulty || 'Medium',
      generated: q.generated === undefined ? true : !!q.generated
    })).filter(q => q.pack_id && q.question_text);

    // Remove duplicates inside the same request first.
    const seenInRequest = new Set();
    const dedupedInRequest = prepared.filter(q => {
      const key = `${q.pack_id}::${q.question_text.toLowerCase()}`;
      if (seenInRequest.has(key)) return false;
      seenInRequest.add(key);
      return true;
    });

    // Prevent duplicate saves against existing database rows: same pack_id + same question_text.
    const packIds = [...new Set(dedupedInRequest.map(q => q.pack_id))];
    let existingKeys = new Set();

    if (packIds.length) {
      const { data: existing, error: existingError } = await supabaseAdmin
        .from('questions')
        .select('pack_id, question_text')
        .in('pack_id', packIds);

      if (existingError) throw existingError;

      existingKeys = new Set((existing || []).map(row => (
        `${row.pack_id}::${normalizeQuestionText(row.question_text).toLowerCase()}`
      )));
    }

    const questionsToSave = dedupedInRequest.filter(q => (
      !existingKeys.has(`${q.pack_id}::${q.question_text.toLowerCase()}`)
    ));

    if (!questionsToSave.length) {
      console.warn('[Backend DB] No new questions to save after duplicate check');
      return [];
    }

    const { data, error } = await supabaseAdmin
      .from('questions')
      .insert(questionsToSave)
      .select();

    if (error) {
      console.error('[Backend DB] Save questions error:', error);
      throw error;
    }

    return data;
  } catch (error) {
    console.error('[Backend DB] Save questions failed:', error);
    throw error;
  }
};

/**
 * Get all questions from database with optional filters
 * @param {Object} filters - Filter options
 * @returns {Promise<{data: Array, count: number}>} - Questions and total count
 */
export const getAllQuestions = async (filters = {}) => {
  try {
    let query = supabaseAdmin
      .from('questions')
      .select(`
        *,
        learning_packs:pack_id (
          id,
          title,
          subject_id,
          subjects:subject_id (
            id,
            name,
            name_si,
            name_ta,
            icon,
            color
          )
        )
      `, { count: 'exact' });

    // Apply filters
    if (filters.pack_id) query = query.eq('pack_id', filters.pack_id);
    if (filters.subject_id) {
      query = query.eq('learning_packs.subject_id', filters.subject_id);
    }
    if (filters.type) query = query.eq('question_type', normalizeQuestionType(filters.type));
    if (filters.difficulty) query = query.eq('difficulty', filters.difficulty);

    // Add sorting
    query = query.order('display_order', { ascending: true })
                .order('created_at', { ascending: false });

    // Apply pagination if provided
    if (filters.page && filters.limit) {
      const page = parseInt(filters.page) || 1;
      const limit = Math.min(parseInt(filters.limit) || 20, 100);
      const from = (page - 1) * limit;
      const to = from + limit - 1;
      query = query.range(from, to);
    }

    const { data, error, count } = await query;

    if (error) throw error;

    return {
      data: data || [],
      count: count || 0
    };
  } catch (error) {
    console.error('[Backend DB] Get questions error:', error);
    throw error;
  }
};

/**
 * Update entire question
 * @param {string} questionId - Question ID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} - Updated question
 */
export const updateQuestion = async (questionId, updates) => {
  try {
    const normalizedUpdates = { ...updates };
    if (normalizedUpdates.question_type || normalizedUpdates.type) {
      normalizedUpdates.question_type = normalizeQuestionType(normalizedUpdates.question_type || normalizedUpdates.type);
      delete normalizedUpdates.type;
    }
    if (normalizedUpdates.question_text) {
      normalizedUpdates.question_text = normalizeQuestionText(normalizedUpdates.question_text);
    }

    const { data, error } = await supabaseAdmin
      .from('questions')
      .update(normalizedUpdates)
      .eq('id', questionId)
      .select()
      .single();

    if (error) {
      console.error('[Backend DB] Update question error:', error);
      throw error;
    }

    return data;
  } catch (error) {
    console.error('[Backend DB] Update question failed:', error);
    throw error;
  }
};

/**
 * Update question difficulty (admin tagging)
 * @param {string} questionId - Question ID
 * @param {string} difficulty - New difficulty level
 * @returns {Promise<Object>} - Updated question
 */
export const updateQuestionDifficulty = async (questionId, difficulty) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('questions')
      .update({ difficulty })
      .eq('id', questionId)
      .select()
      .single();

    if (error) {
      console.error('[Backend DB] Update difficulty error:', error);
      throw error;
    }

    return data;
  } catch (error) {
    console.error('[Backend DB] Update difficulty failed:', error);
    throw error;
  }
};

/**
 * Delete question
 * @param {string} questionId - Question ID
 * @returns {Promise<void>}
 */
export const deleteQuestion = async (questionId) => {
  try {
    const { error } = await supabaseAdmin
      .from('questions')
      .delete()
      .eq('id', questionId);

    if (error) throw error;
  } catch (error) {
    console.error('[Backend DB] Delete question error:', error);
    throw error;
  }
};

/**
 * Summaries: fetch by pack_id
 */
export const getSummaryByPack = async (pack_id) => {
  try {
    // Fetch summary section from pack_sections
    const { data, error } = await supabaseAdmin
      .from('pack_sections')
      .select('id, pack_id, section_type, title, content')
      .eq('pack_id', pack_id)
      .eq('section_type', 'summary')
      .order('display_order', { ascending: true })
      .maybeSingle();

    if (error && error.code !== 'PGRST116') throw error;
    if (!data) return { pack_id, bullets: [] };

    const content = data.content || {};
    const bullets = Array.isArray(content.bullets) ? content.bullets : [];
    return { pack_id, bullets };
  } catch (error) {
    console.error('[Backend DB] Get summary error:', error);
    throw error;
  }
};

/**
 * Summaries: upsert by pack_id
 */
export const upsertSummaryByPack = async (pack_id, bullets) => {
  try {
    // Normalize bullets
    const normalized = (Array.isArray(bullets) ? bullets : [])
      .map(b => (typeof b === 'string' ? b.trim() : ''))
      .filter(Boolean)
      .slice(0, 50);

    // Check if a summary section exists
    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('pack_sections')
      .select('id')
      .eq('pack_id', pack_id)
      .eq('section_type', 'summary')
      .maybeSingle();

    if (fetchErr && fetchErr.code !== 'PGRST116') throw fetchErr;

    if (existing && existing.id) {
      const { data, error } = await supabaseAdmin
        .from('pack_sections')
        .update({
          title: 'Summary',
          content: { bullets: normalized }
        })
        .eq('id', existing.id)
        .select('id, pack_id, content')
        .single();
      if (error) throw error;
      return { pack_id, bullets: data?.content?.bullets || normalized };
    }

    const insertRow = {
      pack_id,
      section_type: 'summary',
      title: 'Summary',
      content: { bullets: normalized },
      display_order: 0,
      has_diagram: false,
      diagram_path: null
    };

    const { data, error } = await supabaseAdmin
      .from('pack_sections')
      .insert([insertRow])
      .select('id, pack_id, content')
      .single();

    if (error) throw error;
    return { pack_id, bullets: data?.content?.bullets || normalized };
  } catch (error) {
    console.error('[Backend DB] Upsert summary error:', error);
    throw error;
  }
};

export default supabaseAdmin;