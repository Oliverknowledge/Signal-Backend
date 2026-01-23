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
 * Fetches YouTube transcript using YouTube's timedtext API
 * Tries multiple language codes and methods
 */
async function fetchYouTubeTranscript(videoId: string): Promise<string> {
  // Try multiple language codes in order of preference
  const languageCodes = ['en', 'en-US', 'en-GB', 'en-CA', 'en-AU'];
  
  // Method 1: Try direct timedtext API with different language codes
  for (const lang of languageCodes) {
    try {
      const transcriptApiUrl = `https://www.youtube.com/api/timedtext?lang=${lang}&v=${videoId}&fmt=srv3`;
      const response = await fetch(transcriptApiUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (response.ok) {
        const xml = await response.text();
        // Check if we got actual transcript data (not an error page)
        if (xml.includes('<transcript>') || xml.includes('<text')) {
          const transcript = parseTranscriptXml(xml);
          if (transcript) {
            return transcript;
          }
        }
      }
    } catch (error) {
      // Continue to next language
      continue;
    }
  }

  // Method 2: Try without language parameter (YouTube auto-detects)
  try {
    const transcriptApiUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&fmt=srv3`;
    const response = await fetch(transcriptApiUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      const xml = await response.text();
      if (xml.includes('<transcript>') || xml.includes('<text')) {
        const transcript = parseTranscriptXml(xml);
        if (transcript) {
          return transcript;
        }
      }
    }
  } catch (error) {
    console.error('Failed to fetch YouTube transcript (auto-detect):', error);
  }

  // Method 3: Try fetching video page to get caption track info
  try {
    const videoPageUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const response = await fetch(videoPageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      const html = await response.text();
      
      // Try to extract caption track URL from the page
      // YouTube embeds caption track info in the page
      const captionTrackMatch = html.match(/"captionTracks":\[([^\]]+)\]/);
      if (captionTrackMatch) {
        try {
          const captionTracks = JSON.parse(`[${captionTrackMatch[1]}]`);
          // Try the first available caption track
          if (captionTracks.length > 0 && captionTracks[0].baseUrl) {
            const captionUrl = captionTracks[0].baseUrl;
            const captionResponse = await fetch(captionUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              },
              signal: AbortSignal.timeout(10000),
            });

            if (captionResponse.ok) {
              const xml = await captionResponse.text();
              const transcript = parseTranscriptXml(xml);
              if (transcript) {
                return transcript;
              }
            }
          }
        } catch (parseError) {
          // Continue to error
        }
      }
    }
  } catch (error) {
    console.error('Failed to fetch YouTube video page:', error);
  }

  throw new Error(`Unable to fetch transcript for YouTube video: ${videoId}. The video may not have captions available.`);
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
