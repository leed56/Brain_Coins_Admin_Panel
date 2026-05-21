import React, { createContext, useContext, useState, useEffect } from 'react';

const ContentGenerationContext = createContext();

export const useContentGeneration = () => {
  const context = useContext(ContentGenerationContext);
  if (!context) {
    throw new Error('useContentGeneration must be used within ContentGenerationProvider');
  }
  return context;
};

export const ContentGenerationProvider = ({ children }) => {
  // File upload state
  const [uploadedFile, setUploadedFile] = useState(null);
  const [uploadedFileUrl, setUploadedFileUrl] = useState(() => localStorage.getItem('uploadedFileUrl') || '');
  const [uploadedFileType, setUploadedFileType] = useState(() => localStorage.getItem('uploadedFileType') || '');
  const [uploadedFileName, setUploadedFileName] = useState(() => localStorage.getItem('uploadedFileName') || '');
  
  // Learning packs state
  const [suggestedPacks, setSuggestedPacks] = useState(() => {
    const savedPacks = localStorage.getItem('suggestedPacks');
    return savedPacks ? JSON.parse(savedPacks) : [];
  });
  // Use localStorage to persist selectedPackIndex
  const [selectedPackIndex, setSelectedPackIndex] = useState(() => {
    const savedIndex = localStorage.getItem('selectedPackIndex');
    return savedIndex !== null ? parseInt(savedIndex, 10) : null;
  });
  // Use localStorage to persist selectedPackIndices
  const [selectedPackIndices, setSelectedPackIndices] = useState(() => {
    const savedIndices = localStorage.getItem('selectedPackIndices');
    return savedIndices ? JSON.parse(savedIndices) : [];
  });
  const [detectedLanguage, setDetectedLanguage] = useState('English');
  
  // Update localStorage when selectedPackIndex changes
  useEffect(() => {
    if (selectedPackIndex === null) {
      localStorage.removeItem('selectedPackIndex');
    } else {
      localStorage.setItem('selectedPackIndex', selectedPackIndex.toString());
    }
  }, [selectedPackIndex]);
  
  // Update localStorage when suggestedPacks changes
  useEffect(() => {
    localStorage.setItem('suggestedPacks', JSON.stringify(suggestedPacks));
  }, [suggestedPacks]);
  
  // Update localStorage when selectedPackIndices changes
  useEffect(() => {
    localStorage.setItem('selectedPackIndices', JSON.stringify(selectedPackIndices));
  }, [selectedPackIndices]);

  // Update localStorage when uploaded file info changes
  useEffect(() => {
    if (uploadedFileUrl) {
      localStorage.setItem('uploadedFileUrl', uploadedFileUrl);
    } else {
      localStorage.removeItem('uploadedFileUrl');
    }
  }, [uploadedFileUrl]);

  useEffect(() => {
    if (uploadedFileType) {
      localStorage.setItem('uploadedFileType', uploadedFileType);
    } else {
      localStorage.removeItem('uploadedFileType');
    }
  }, [uploadedFileType]);

  useEffect(() => {
    if (uploadedFile?.name) {
      localStorage.setItem('uploadedFileName', uploadedFile.name);
      setUploadedFileName(uploadedFile.name);
    } else if (!uploadedFileUrl) { // Clear name if URL is also cleared
      localStorage.removeItem('uploadedFileName');
      setUploadedFileName('');
    }
  }, [uploadedFile, uploadedFileUrl]);
  
  // Question generation state
  const [preview, setPreview] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [summaryBullets, setSummaryBullets] = useState([]);
  
  // UI state
  const [isGenerating, setIsGenerating] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [generationError, setGenerationError] = useState('');
  const [generationStage, setGenerationStage] = useState('idle');
  const [generationStatusText, setGenerationStatusText] = useState('');
  const [showUploadForm, setShowUploadForm] = useState(false);
  
  // Question type configuration
  const [questionTypeCounts, setQuestionTypeCounts] = useState({
    MCQ: 20,
    FIIB: 15,
    TF: 10,
    HOQ: 3
  });
  
  const [questionTypeDifficulties, setQuestionTypeDifficulties] = useState({
    MCQ: 'Medium',
    FIIB: 'Medium',
    TF: 'Easy',
    HOQ: 'Hard'
  });

  // Reset all state (useful when starting fresh)
  const resetAllState = () => {
    // Clear state
    setUploadedFile(null);
    setUploadedFileUrl('');
    setUploadedFileType('');
    setUploadedFileName('');
    setSuggestedPacks([]);
    setSelectedPackIndex(null);
    setSelectedPackIndices([]);
    setDetectedLanguage('English');
    setPreview(null);
    setQuestions([]);
    setSummaryBullets([]);
    setIsGenerating(false);
    setIsAnalyzing(false);
    setGenerationError('');
    setGenerationStage('idle');
    setGenerationStatusText('');
    setShowUploadForm(false);
    
    // Clear localStorage
    localStorage.removeItem('selectedPackIndex');
    localStorage.removeItem('selectedPackIndices');
    localStorage.removeItem('suggestedPacks');
    localStorage.removeItem('uploadedFileUrl');
    localStorage.removeItem('uploadedFileType');
    localStorage.removeItem('uploadedFileName');
  };

  // Reset only generation state (keep file and packs)
  const resetGenerationState = () => {
    setPreview(null);
    setQuestions([]);
    setSummaryBullets([]);
    setIsGenerating(false);
    setGenerationError('');
    setGenerationStage('idle');
    setGenerationStatusText('');
  };

  const setGenerationProgress = (stage, text = '') => {
    setGenerationStage(stage || 'idle');
    setGenerationStatusText(text || '');
  };

  return (
    <ContentGenerationContext.Provider value={{
      // File upload
      uploadedFile,
      setUploadedFile,
      uploadedFileUrl,
      setUploadedFileUrl,
      uploadedFileType,
      setUploadedFileType,
      uploadedFileName,
      setUploadedFileName,
      
      // Learning packs
      suggestedPacks,
      setSuggestedPacks,
      selectedPackIndex,
      setSelectedPackIndex,
      selectedPackIndices,
      setSelectedPackIndices,
      detectedLanguage,
      setDetectedLanguage,
      
      // Question generation
      preview,
      setPreview,
      questions,
      setQuestions,
      summaryBullets,
      setSummaryBullets,
      
      // UI state
      isGenerating,
      setIsGenerating,
      isAnalyzing,
      setIsAnalyzing,
      generationError,
      setGenerationError,
      generationStage,
      setGenerationStage,
      generationStatusText,
      setGenerationStatusText,
      setGenerationProgress,
      showUploadForm,
      setShowUploadForm,
      
      // Question configuration
      questionTypeCounts,
      setQuestionTypeCounts,
      questionTypeDifficulties,
      setQuestionTypeDifficulties,
      
      // Helper functions
      resetAllState,
      resetGenerationState
    }}>
      {children}
    </ContentGenerationContext.Provider>
  );
};