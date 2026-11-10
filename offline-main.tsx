/// <reference types="vite/client" />
import React from 'react';
import { createRoot } from 'react-dom/client';
import Home from './app/page';
import './app/globals.css';
const configuredFeedback = import.meta.env.VITE_FEEDBACK_URL?.trim() || '';
const feedbackUrl = /^https:\/\/wj\.qq\.com\/[^\s]+$/.test(configuredFeedback)
  ? configuredFeedback
  : undefined;

createRoot(document.getElementById('root')!).render(<Home feedbackUrl={feedbackUrl}/>);
