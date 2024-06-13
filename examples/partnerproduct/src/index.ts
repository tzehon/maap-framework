import 'dotenv/config';
import {
    getDatabaseConfig,
    getModelClass,
    getIngestLoader,
    getEmbeddingModel,
} from '../../../src/yaml_parser/src/LoadYaml.js';
import {
    PreProcessQuery,
    RAGApplicationBuilder,
    Rerank,
    convertBaseEmbeddingsToEmbedder,
    convertBaseModelToChatLlm,
    withQueryPreprocessor,
    withReranker,
} from '../../../src/index.js';
import { MongoClient } from 'mongodb';
import {
    makeDefaultFindContent,
    MakeUserMessageFunc,
    OpenAiChatMessage,
    GenerateUserPromptFunc,
    makeRagGenerateUserPrompt,
    SystemPrompt,
    makeMongoDbConversationsService,
    AppConfig,
    makeApp,
} from 'mongodb-chatbot-server';
import { makeMongoDbEmbeddedContentStore, makeOpenAiEmbedder, logger } from 'mongodb-rag-core';
import path from 'path';
import { loadEnvVars } from './loadEnvVars.js';

// Load project environment variables
const dotenvPath = '/Users/utsavtalwar/Desktop/Tech-Partner/chatbot/examples/partnerproduct/.env'; //path.join(__dirname, "..", ".env"); // update with real path
const { MONGODB_CONNECTION_URI, MONGODB_DATABASE_NAME, VECTOR_SEARCH_INDEX_NAME } = loadEnvVars(dotenvPath);

// Load MAAP base classes
const model = getModelClass();
const embedding_model = getEmbeddingModel();

// MongoDB data source for the content used in RAG.
// Generated with the Ingest CLI.
const embeddedContentStore = makeMongoDbEmbeddedContentStore({
    connectionUri: MONGODB_CONNECTION_URI,
    databaseName: MONGODB_DATABASE_NAME,
});

// Convert MAAP base embeddings to framework's Embedder
// console.log(embedding_model)
const embedder = convertBaseEmbeddingsToEmbedder(embedding_model);

// Convert MAAP base LLM to framework's ChatLlm
console.log(model);
const llm = await convertBaseModelToChatLlm(model);

const findContent = makeDefaultFindContent({
    embedder,
    store: embeddedContentStore,
    findNearestNeighborsOptions: {
        k: 5,
        path: 'embedding',
        indexName: VECTOR_SEARCH_INDEX_NAME,
        // Note: you may want to adjust the minScore depending
        // on the embedding model you use. We've found 0.9 works well
        // for OpenAI's text-embedding-ada-02 model for most use cases,
        // but you may want to adjust this value if you're using a different model.
        minScore: 0.9,
    },
});

// For MAAP team: this shows how to use the withReranker and withQueryPreprocessor
// functions to wrap the findContent function with reranking and preprocessing functionality.
const dummyRerank: Rerank = async ({ query, results }) => {
    return { results };
};
const dummyPreprocess: PreProcessQuery = async ({ query }) => {
    return { preprocessedQuery: query };
};
const findContentWithRerank = withReranker({ findContentFunc: findContent, reranker: dummyRerank });
const findContentWithRerankAndPreprocess = withQueryPreprocessor({
    findContentFunc: findContentWithRerank,
    queryPreprocessor: dummyPreprocess,
});

// Constructs the user message sent to the LLM from the initial user message
// and the content found by the findContent function.
const makeUserMessage: MakeUserMessageFunc = async function ({
    content,
    originalUserMessage,
}): Promise<OpenAiChatMessage & { role: 'user' }> {
    const chunkSeparator = '~~~~~~';
    const context = content.map((c) => c.text).join(`\n${chunkSeparator}\n`);
    const contentForLlm = `Using the following information, answer the user query.
Different pieces of information are separated by "${chunkSeparator}".

Information:
${context}


User query: ${originalUserMessage}`;
    return { role: 'user', content: contentForLlm };
};

// Generates the user prompt for the chatbot using RAG
const generateUserPrompt: GenerateUserPromptFunc = makeRagGenerateUserPrompt({
    findContent: findContentWithRerankAndPreprocess,
    makeUserMessage,
});

// System prompt for chatbot
const systemPrompt: SystemPrompt = {
    role: 'system',
    content: `You are an assistant to users of the MongoDB Chatbot Framework.
Answer their questions about the framework in a friendly conversational tone.
Format your answers in Markdown.
Be concise in your answers.
If you do not know the answer to the question based on the information provided,
respond: "I'm sorry, I don't know the answer to that question. Please try to rephrase it. Refer to the below information to see if it helps."`,
};

// Create MongoDB collection and service for storing user conversations
// with the chatbot.
const mongodb = new MongoClient(MONGODB_CONNECTION_URI);
const conversations = makeMongoDbConversationsService(mongodb.db(MONGODB_DATABASE_NAME));

// Create the MongoDB Chatbot Server Express.js app configuration
const config: AppConfig = {
    conversationsRouterConfig: {
        llm,
        conversations,
        generateUserPrompt,
        systemPrompt,
    },
    maxRequestTimeoutMs: 30000,
    serveStaticSite: true,
};

// Start the server and clean up resources on SIGINT.
const PORT = process.env.PORT || 9000;
const startServer = async () => {
    logger.info('Starting server...');
    const app = await makeApp(config);
    const server = app.listen(PORT, () => {
        logger.info(`Server listening on port: ${PORT}`);
    });

    process.on('SIGINT', async () => {
        logger.info('SIGINT signal received');
        await mongodb.close();
        await embeddedContentStore.close();
        await new Promise<void>((resolve, reject) => {
            server.close((error: any) => {
                error ? reject(error) : resolve();
            });
        });
        process.exit(1);
    });
};

try {
    startServer();
} catch (e) {
    logger.error(`Fatal error: ${e}`);
    process.exit(1);
}
