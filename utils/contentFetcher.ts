/**
 * Content fetcher for Signal AI analysis endpoint
 * Handles YouTube transcripts and HTML content extraction
 */

import { load } from 'cheerio';

const MAX_CONTENT_LENGTH = 50000; // Safe token limit (~12k tokens)

/**
 * Extracts YouTube video ID from URL
 */
function extractYouTubeId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
    /youtube\.com\/watch\?.*v=([^&\n?#]+)/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  return null;
}

/**
 * Fetches YouTube transcript using yt-dlp or transcript API
 * Falls back to a simple fetch if transcript API is available
 */
async function fetchYouTubeTranscript(videoId: string): Promise<string> {
  // Try using a transcript API service (you may need to configure this)
  // For now, we'll use a simple approach with yt-transcript or similar
  // In production, you might want to use a service like YouTube Transcript API
  
  try {
    // Option 1: Use a transcript API if available
    const transcriptApiUrl = `https://www.youtube.com/api/timedtext?lang=en&v=${videoId}`;
    const response = await fetch(transcriptApiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Signal-Bot/1.0)',
      },
    });

    if (response.ok) {
      const xml = await response.text();
      // Simple XML parsing to extract text
      const textMatches = xml.match(/<text[^>]*>([^<]+)<\/text>/g);
      if (textMatches && textMatches.length > 0) {
        const transcript = textMatches
          .map((match) => {
            // Extract text content and decode HTML entities
            const textContent = match.replace(/<[^>]+>/g, '');
            return textContent
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/&nbsp;/g, ' ');
          })
          .join(' ')
          .trim();
        
        if (transcript.length > 0) {
          return transcript.substring(0, MAX_CONTENT_LENGTH);
        }
      }
    }
  } catch (error) {
    console.error('Failed to fetch YouTube transcript:', error);
  }

  // Fallback: Try alternative transcript service
  // You might want to integrate with a service like RapidAPI YouTube Transcript
  throw new Error(`Unable to fetch transcript for YouTube video: ${videoId}`);
}

/**
 * Fetches HTML content and extracts readable text
 */
async function fetchHtmlContent(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Signal-Bot/1.0)',
    },
    signal: AbortSignal.timeout(10000), // 10 second timeout
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch content: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  
  // Use cheerio to extract text content
  const $ = load(html);
  
  // Remove script and style elements
  $('script, style, noscript').remove();
  
  // Extract text from main content areas
  const selectors = ['article', 'main', '[role="main"]', '.content', '.post', '.article'];
  let text = '';
  
  for (const selector of selectors) {
    const content = $(selector).first();
    if (content.length > 0) {
      text = content.text();
      break;
    }
  }
  
  // Fallback to body if no main content found
  if (!text) {
    text = $('body').text();
  }
  
  // Clean up whitespace
  text = text
    .replace(/\s+/g, ' ')
    .replace(/\n+/g, '\n')
    .trim();
  
  // Limit content length
  if (text.length > MAX_CONTENT_LENGTH) {
    text = text.substring(0, MAX_CONTENT_LENGTH);
  }
  
  return text;
}

/**
 * Fetches content from a URL (YouTube transcript or HTML)
 */
export async function fetchContent(url: string): Promise<string> {
  const youtubeId = extractYouTubeId(url);
  
  if (youtubeId) {
    return await fetchYouTubeTranscript(youtubeId);
  } else {
    return await fetchHtmlContent(url);
  }
}
