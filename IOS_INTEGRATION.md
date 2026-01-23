# iOS Integration Guide: `/api/analyze` Endpoint

This guide provides everything you need to call the `/api/analyze` endpoint from your iOS app.

## Endpoint Overview

**URL:** `POST https://your-project.vercel.app/api/analyze`  
**Content-Type:** `application/json`  
**Timeout:** Up to 60 seconds (server-side)

## Request Structure

### Swift  Models

```swift
import Foundation

// MARK: - Request Models
struct AnalyzeRequest: Codable {
    let contentUrl: String
    let userIdHash: String
    let goalId: String
    let goalDescription: String
    let knownConcepts: [String]
    let weakConcepts: [String]
    
}

// MARK: - Response Models
struct AnalyzeResponse: Codable {
    let traceId: String
    let concepts: [String]
    let relevanceScore: Double
    let learningValueScore: Double
    let decision: Decision
    let recallQuestions: [RecallQuestion]
}

enum Decision: String, Codable {
    case triggered
    case ignored
}

struct RecallQuestion: Codable {
    let question: String
    let type: QuestionType
}

enum QuestionType: String, Codable {
    case open
    case mcq
}

// MARK: - Error Response
struct ErrorResponse: Codable {
    let error: String
    let message: String?
    let details: [ValidationError]?
}

struct ValidationError: Codable {
    let path: [String]
    let message: String
}
```

## Complete Implementation Example

```swift
import Foundation

class SignalAPIClient {
    private let baseURL: String
    private let session: URLSession
    
    init(baseURL: String) {
        self.baseURL = baseURL
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 90 // Client timeout > server timeout
        config.timeoutIntervalForResource = 90
        self.session = URLSession(configuration: config)
    }
    
    /// Analyzes content and returns AI-powered learning insights
    /// - Parameters:
    ///   - request: The analyze request with content URL and user context
    ///   - completion: Completion handler with result or error
    func analyzeContent(
        request: AnalyzeRequest,
        completion: @escaping (Result<AnalyzeResponse, AnalyzeError>) -> Void
    ) {
        guard let url = URL(string: "\(baseURL)/api/analyze") else {
            completion(.failure(.invalidURL))
            return
        }
        
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        do {
            let encoder = JSONEncoder()
            encoder.keyEncodingStrategy = .convertToSnakeCase
            urlRequest.httpBody = try encoder.encode(request)
        } catch {
            completion(.failure(.encodingError(error)))
            return
        }
        
        let task = session.dataTask(with: urlRequest) { data, response, error in
            // Handle network errors
            if let error = error {
                completion(.failure(.networkError(error)))
                return
            }
            
            guard let httpResponse = response as? HTTPURLResponse else {
                completion(.failure(.invalidResponse))
                return
            }
            
            guard let data = data else {
                completion(.failure(.noData))
                return
            }
            
            // Handle error responses (400, 500, etc.)
            if !(200...299).contains(httpResponse.statusCode) {
                do {
                    let decoder = JSONDecoder()
                    let errorResponse = try decoder.decode(ErrorResponse.self, from: data)
                    completion(.failure(.apiError(
                        statusCode: httpResponse.statusCode,
                        message: errorResponse.message ?? errorResponse.error,
                        details: errorResponse.details
                    )))
                } catch {
                    completion(.failure(.apiError(
                        statusCode: httpResponse.statusCode,
                        message: String(data: data, encoding: .utf8) ?? "Unknown error",
                        details: nil
                    )))
                }
                return
            }
            
            // Parse successful response
            do {
                let decoder = JSONDecoder()
                decoder.keyDecodingStrategy = .convertFromSnakeCase
                let response = try decoder.decode(AnalyzeResponse.self, from: data)
                completion(.success(response))
            } catch {
                completion(.failure(.decodingError(error)))
            }
        }
        
        task.resume()
    }
}

// MARK: - Error Types
enum AnalyzeError: LocalizedError {
    case invalidURL
    case encodingError(Error)
    case networkError(Error)
    case invalidResponse
    case noData
    case decodingError(Error)
    case apiError(statusCode: Int, message: String, details: [ValidationError]?)
    
    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid API URL"
        case .encodingError(let error):
            return "Failed to encode request: \(error.localizedDescription)"
        case .networkError(let error):
            return "Network error: \(error.localizedDescription)"
        case .invalidResponse:
            return "Invalid HTTP response"
        case .noData:
            return "No data received from server"
        case .decodingError(let error):
            return "Failed to decode response: \(error.localizedDescription)"
        case .apiError(let statusCode, let message, _):
            return "API error (\(statusCode)): \(message)"
        }
    }
}
```

## Usage Example

```swift
// Initialize the client
let apiClient = SignalAPIClient(
    baseURL: "https://your-project.vercel.app"
)

// Create the request
let request = AnalyzeRequest(
    contentUrl: "https://youtube.com/watch?v=dQw4w9WgXcQ",
    userIdHash: "abc123hashed",
    goalId: "goal-123",
    goalDescription: "Learn machine learning fundamentals",
    knownConcepts: ["neural networks", "backpropagation"],
    weakConcepts: ["gradient descent", "optimization"]
)

// Make the API call
apiClient.analyzeContent(request: request) { result in
    switch result {
    case .success(let response):
        print("Trace ID: \(response.traceId)")
        print("Decision: \(response.decision)")
        print("Relevance Score: \(response.relevanceScore)")
        print("Learning Value Score: \(response.learningValueScore)")
        print("Concepts: \(response.concepts)")
        
        if response.decision == .triggered {
            print("Recall Questions:")
            for question in response.recallQuestions {
                print("  - \(question.question) (\(question.type.rawValue))")
            }
        }
        
        // Update UI on main thread
        DispatchQueue.main.async {
            // Handle success in your UI
        }
        
    case .failure(let error):
        print("Error: \(error.localizedDescription)")
        
        // Handle specific error types
        if case .apiError(let statusCode, let message, let details) = error {
            if statusCode == 400 {
                print("Validation errors:")
                details?.forEach { detail in
                    print("  - \(detail.path.joined(separator: ".")): \(detail.message)")
                }
            }
        }
        
        // Update UI on main thread
        DispatchQueue.main.async {
            // Handle error in your UI
        }
    }
}
```

## SwiftUI Integration Example

```swift
import SwiftUI

class AnalyzeViewModel: ObservableObject {
    @Published var isLoading = false
    @Published var result: AnalyzeResponse?
    @Published var errorMessage: String?
    
    private let apiClient = SignalAPIClient(
        baseURL: "https://your-project.vercel.app"
    )
    
    func analyze(
        contentUrl: String,
        userIdHash: String,
        goalId: String,
        goalDescription: String,
        knownConcepts: [String] = [],
        weakConcepts: [String] = []
    ) {
        isLoading = true
        errorMessage = nil
        
        let request = AnalyzeRequest(
            contentUrl: contentUrl,
            userIdHash: userIdHash,
            goalId: goalId,
            goalDescription: goalDescription,
            knownConcepts: knownConcepts,
            weakConcepts: weakConcepts
        )
        
        apiClient.analyzeContent(request: request) { [weak self] result in
            DispatchQueue.main.async {
                self?.isLoading = false
                
                switch result {
                case .success(let response):
                    self?.result = response
                case .failure(let error):
                    self?.errorMessage = error.localizedDescription
                }
            }
        }
    }
}

struct AnalyzeView: View {
    @StateObject private var viewModel = AnalyzeViewModel()
    @State private var contentURL = ""
    
    var body: some View {
        VStack(spacing: 20) {
            TextField("Content URL", text: $contentURL)
                .textFieldStyle(RoundedBorderTextFieldStyle())
            
            Button("Analyze Content") {
                viewModel.analyze(
                    contentUrl: contentURL,
                    userIdHash: "user-hash-here",
                    goalId: "goal-123",
                    goalDescription: "Learn machine learning"
                )
            }
            .disabled(viewModel.isLoading || contentURL.isEmpty)
            
            if viewModel.isLoading {
                ProgressView("Analyzing...")
            }
            
            if let error = viewModel.errorMessage {
                Text("Error: \(error)")
                    .foregroundColor(.red)
            }
            
            if let result = viewModel.result {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Decision: \(result.decision.rawValue)")
                    Text("Relevance: \(result.relevanceScore, specifier: "%.2f")")
                    Text("Learning Value: \(result.learningValueScore, specifier: "%.2f")")
                    
                    if result.decision == .triggered {
                        Text("Recall Questions:")
                            .font(.headline)
                        ForEach(result.recallQuestions, id: \.question) { question in
                            Text("• \(question.question)")
                        }
                    }
                }
                .padding()
            }
        }
        .padding()
    }
}
```

## Error Handling Guide

### Common Error Scenarios

1. **400 Bad Request** - Invalid request schema
   ```swift
   // Check error.details for validation errors
   if case .apiError(400, _, let details) = error {
       // Handle validation errors
   }
   ```

2. **400 Bad Request** - Content fetch failed
   ```swift
   // URL might be invalid or content inaccessible
   // Show user-friendly message
   ```

3. **500 Internal Server Error** - AI analysis failed
   ```swift
   // Server-side error, retry or show generic error
   ```

4. **Network Timeout** - Request took too long
   ```swift
   // Increase timeout or show "Request timed out" message
   ```

## Best Practices

1. **Always handle errors gracefully** - Show user-friendly messages
2. **Use background queue for API calls** - Keep UI responsive
3. **Update UI on main thread** - All UI updates must be on main thread
4. **Store base URL in configuration** - Use environment-based URLs
5. **Implement retry logic** - For transient network errors
6. **Cache trace IDs** - For correlating with Opik logs later
7. **Validate URLs client-side** - Before sending to API

## Configuration

Store your API base URL in a configuration file:

```swift
struct APIConfig {
    static let baseURL: String = {
        #if DEBUG
        return "https://your-dev-project.vercel.app"
        #else
        return "https://your-prod-project.vercel.app"
        #endif
    }()
}
```

## Testing

Example test with mock data:

```swift
func testAnalyzeContent() {
    let expectation = XCTestExpectation(description: "Analyze content")
    
    let request = AnalyzeRequest(
        contentUrl: "https://youtube.com/watch?v=test",
        userIdHash: "test-hash",
        goalId: "test-goal",
        goalDescription: "Test goal",
        knownConcepts: [],
        weakConcepts: []
    )
    
    apiClient.analyzeContent(request: request) { result in
        switch result {
        case .success(let response):
            XCTAssertEqual(response.decision, .triggered)
            XCTAssertFalse(response.concepts.isEmpty)
        case .failure(let error):
            XCTFail("Request failed: \(error)")
        }
        expectation.fulfill()
    }
    
    wait(for: [expectation], timeout: 90)
}
```

## Notes

- **Timeout**: The server has a 60-second timeout. Set your client timeout to 90 seconds to account for network latency.
- **Content Types**: Supports YouTube videos (via URL) and web articles (any URL).
- **Concepts Arrays**: Both `knownConcepts` and `weakConcepts` are optional and default to empty arrays.
- **Decision Logic**: Content is "triggered" when both `relevanceScore` and `learningValueScore` are ≥ 0.7.
- **Recall Questions**: Only returned when `decision == "triggered"`.
