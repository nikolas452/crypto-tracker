import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let mongod: MongoMemoryServer | undefined;

/** Starts an in-memory MongoDB instance and connects the global Mongoose singleton to it. */
export async function startInMemoryMongo(): Promise<string> {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri, { dbName: 'crypto_tracker_test' });
  return uri;
}

/** Disconnects Mongoose and tears down the in-memory MongoDB instance. */
export async function stopInMemoryMongo(): Promise<void> {
  await mongoose.disconnect().catch(() => undefined);
  if (mongod) {
    await mongod.stop();
    mongod = undefined;
  }
}

/** Removes all documents from every collection so each test starts from a clean database. */
export async function clearDatabase(): Promise<void> {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
}
