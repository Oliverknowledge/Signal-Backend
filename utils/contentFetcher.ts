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
 * Parses XML transcript and extracts text content
 */
function parseTranscriptXml(xml: string): string | null {
  try {
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
            .replace(/&nbsp;/g, ' ')
            .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
            .replace(/&apos;/g, "'");
        })
        .join(' ')
        .trim();
      
      if (transcript.length > 0) {
        return transcript.substring(0, MAX_CONTENT_LENGTH);
      }
    }
  } catch (error) {
    console.error('Failed to parse transcript XML:', error);
  }
  return null;
}

/**
 * Fetches YouTube transcript by extracting caption tracks from video page
 * Works with both manual and auto-generated captions
 */

  
/**
 * Fetches YouTube transcript using RapidAPI youtube-transcript3 API
 */
async function fetchYouTubeTranscript(videoId: string): Promise<string> {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) {
    throw new Error("RAPIDAPI_KEY not set in environment");
  }
  const url = `https://youtube-transcript3.p.rapidapi.com/api/transcript?videoId=${videoId}`;
  try {
    const response = await fetch(url, {
      headers: {
        "x-rapidapi-host": "youtube-transcript3.p.rapidapi.com",
        "x-rapidapi-key": apiKey,
      },
      
    });
    if (!response.ok) {
      throw new Error(`RapidAPI error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    // Validate shape
    if (!data || !(data as any).success || !Array.isArray((data as any).transcript)) {
      throw new Error("Invalid RapidAPI transcript response");
    }

    const transcript = (data as any).transcript
      .map((item: any) => item.text)
      .join(" ")
      .trim();
    console.log(`Transcript: ${transcript}`);
    if (!transcript || transcript.length === 0) {
      throw new Error("Empty transcript returned");
    }

    return transcript.substring(0, MAX_CONTENT_LENGTH);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`Failed to fetch transcript for video ${videoId}:`, message);
    throw new Error(`Unable to fetch transcript via RapidAPI: ${message}`);
  }
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
