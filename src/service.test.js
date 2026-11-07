const request = require('supertest');
const app = require('./service.js');
const { DB } = require('./database/database.js');

beforeAll(async () => {
  await DB.initialized;
});

test('deployment check returns the deployed message', async () => {
  const response = await request(app).get('/checkDeployment');

  expect(response.status).toBe(200);
  expect(response.text).toBe('I have been deployed');
});
