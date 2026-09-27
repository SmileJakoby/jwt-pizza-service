const request = require('supertest');
const app = require('../service');
const { Role, DB } = require('../database/database.js');


function randomName() {
  return Math.random().toString(36).substring(2, 12);
}

if (process.env.VSCODE_INSPECTOR_OPTIONS) {
  jest.setTimeout(60 * 1000 * 5); // 5 minutes
}


async function createAdminUser() {
  let user = { password: 'toomanysecrets', roles: [{ role: Role.Admin }] };
  user.name = randomName();
  user.email = user.name + '@admin.com';

  user = await DB.addUser(user);
  return { ...user, password: 'toomanysecrets' };
}

async function loginAdminUser() {
  let myAdminUser = await createAdminUser()
  const loginRes = await request(app).put('/api/auth').send(myAdminUser);
  return loginRes;
}

async function createNewUser() {
  let user = { password: 'toomanysecrets', roles: [{ role: Role.Diner }] };
  user.name = randomName();
  user.email = user.name + '@diner.com';

  user = await DB.addUser(user);
  return { ...user, password: 'toomanysecrets' };
}

async function createFranchise(adminEmail) {
  return DB.createFranchise({
    name: randomName(),
    admins: [{ email: adminEmail }],
  });
}

async function createFullFranchise() {
  const franchisee = await createNewUser();
  const franchise = await createFranchise(franchisee.email);

  return { franchise, franchisee };
}

async function registerNewUser() {
  const newUser = { name: 'swag', email: 'swag@test.com', password: 'a' };
  newUser.email = Math.random().toString(36).substring(2, 12) + '@test.com';
  const registerRes = await request(app).post('/api/auth').send(newUser);
  return registerRes;
}


const testUser = { name: 'pizza diner', email: 'reg@test.com', password: 'a' };
let testUserAuthToken;

beforeAll(async () => {
  testUser.email = Math.random().toString(36).substring(2, 12) + '@test.com';
  const registerRes = await request(app).post('/api/auth').send(testUser);
  testUserAuthToken = registerRes.body.token;
  testUser.id = registerRes.body.user.id;
  expectValidJwt(testUserAuthToken);
});

test('login', async () => {
  const loginRes = await request(app).put('/api/auth').send(testUser);
  expect(loginRes.status).toBe(200);
  expectValidJwt(loginRes.body.token);

  const expectedUser = { ...testUser, roles: [{ role: 'diner' }] };
  delete expectedUser.password;
  expect(loginRes.body.user).toMatchObject(expectedUser);
});


//Order tests

test('createOrder', async () => {
  const testOrder = {
    franchiseId: 1,
    storeId: 1,
    items: [{ menuId: 1, description: 'Veggie', price: 0.05 }],
  };
  const orderRes = await request(app)
    .post('/api/order')
    .set('Authorization', `Bearer ${testUserAuthToken}`)
    .send(testOrder);
  expect(orderRes.status).toBe(200);
  expect(orderRes.body.order).toMatchObject({
    ...testOrder,
    id: expect.any(Number),
  });
})

test('viewEmptyOrders', async () => {
  //Make a new user
  const newUser = await registerNewUser();
  const viewRes = await request(app)
    .get('/api/order')
    .set('Authorization', `Bearer ${newUser.body.token}`)

  expect(viewRes.status).toBe(200);
  expect(viewRes.body).toMatchObject({
    dinerId: newUser.body.user.id,
    orders: [],
    page: 1,
  });
})

//Menu tests
test('addMenuItem', async () => {
  const newItem = {
    "title": "Bulgogi",
    "image": "bulgogipizza.png",
    "price": 0.005,
    "description": "There is a reason this flavor has struggled to make it out of Korea."
  }
  const adminLoginRes = await loginAdminUser();
  const addRes = await request(app)
    .put('/api/order/menu')
    .set('Authorization', `Bearer ${(adminLoginRes).body.token}`)
    .send(newItem);
  expect(addRes.status).toBe(200);
  expect(addRes.body).toEqual(expect.arrayContaining([expect.objectContaining(newItem)]));
})

test('addMenuItemNotAdmin', async () => {
  const newItem = {
    "title": "Bulgogi",
    "image": "bulgogipizza.png",
    "price": 0.005,
    "description": "There is a reason this flavor has struggled to make it out of Korea."
  }
  const addRes = await request(app)
    .put('/api/order/menu')
    .set('Authorization', `Bearer ${testUserAuthToken}`)
    .send(newItem);
  expect(addRes.status).toBe(403);
  expect(addRes.body.message).toBe('unable to add menu item');
})

test('viewMenuItems', async () => {
  const viewRes = await request(app)
    .get('/api/order/menu');
  expect(viewRes.status).toBe(200);
  expect(Array.isArray(viewRes.body)).toBe(true);
  expect(viewRes.body.length).toBeGreaterThan(0);
  expect(viewRes.body[0]).toEqual(expect.objectContaining({
    id: expect.any(Number),
    title: expect.any(String),
    image: expect.any(String),
    price: expect.any(Number),
    description: expect.any(String),
  }));
})

//Franchise tests
test('createAndDeleteFranchise', async () => {
  //The decision to combine these into one test is for the sake of database cleanliness
  const loginRes = await loginAdminUser();
  const newDiner = await createNewUser();
  const newFranchise = {
    "name": randomName(),
    "admins": [
      {
        "email": newDiner.email
      }
    ]
  }
  const createRes = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${loginRes.body.token}`)
    .send(newFranchise)
  expect(createRes.status).toBe(200);
  expect(createRes.body).toMatchObject({
    id: expect.any(Number),
    name: newFranchise.name,
    admins: [expect.objectContaining({ email: newDiner.email })],
  });

  const deleteRes = await request(app)
    .delete(`/api/franchise/${createRes.body.id}`)
    .set('Authorization', `Bearer ${loginRes.body.token}`)
  expect(deleteRes.status).toBe(200);
  expect(deleteRes.body).toEqual({ message: 'franchise deleted' });
})

test('createAndDeleteFranchiseNotAdmin', async () => {
  const newDiner = await createNewUser();
  const newFranchise = {
    "name": randomName(),
    "admins": [
      {
        "email": newDiner.email
      }
    ]
  }
  const createRes = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${testUserAuthToken}`)
    .send(newFranchise)
  expect(createRes.status).toBe(403);
  expect(createRes.body.message).toBe('unable to create a franchise');

  const existingFranchise = await createFranchise(newDiner.email);
  const deleteRes = await request(app)
    .delete(`/api/franchise/${existingFranchise.id}`)
    .set('Authorization', `Bearer ${testUserAuthToken}`)
  expect(deleteRes.status).toBe(403);
  expect(deleteRes.body.message).toBe('unable to delete a franchise');
  await DB.deleteFranchise(existingFranchise.id);
})

test('createStoreDeleteStore', async () => {
  const { franchise: newFranchise, franchisee: newFranchisee } = await createFullFranchise();

  const loginRes = await request(app).put('/api/auth').send(newFranchisee);
  expect(loginRes.status).toBe(200);
  expectValidJwt(loginRes.body.token);

  const newFranchiseName = randomName();
  const createRes = await request(app)
    .post(`/api/franchise/${newFranchise.id}/store`)
    .set('Authorization', `Bearer ${loginRes.body.token}`)
    .send({ name: newFranchiseName })
  
  expect(createRes.status).toBe(200);
  expect(createRes.body.name).toMatch(newFranchiseName);
  expect(createRes.body).toMatchObject({
    id: expect.any(Number),
    franchiseId: newFranchise.id,
  });

  const deleteRes = await request(app)
    .delete(`/api/franchise/${newFranchise.id}/store/${createRes.body.id}`)
    .set('Authorization', `Bearer ${loginRes.body.token}`)
  
  expect(deleteRes.status).toBe(200);
  expect(deleteRes.body).toEqual({ message: 'store deleted' });
  await DB.deleteFranchise(newFranchise.id);
})

test('createStoreDeleteStoreNotAuthorized', async () => {
  const { franchise: newFranchise } = await createFullFranchise();

  const newFranchiseName = randomName();
  const createRes = await request(app)
    .post(`/api/franchise/${newFranchise.id}/store`)
    .set('Authorization', `Bearer ${testUserAuthToken}`)
    .send({ name: newFranchiseName })
  
  expect(createRes.status).toBe(403);
  expect(createRes.body.message).toBe('unable to create a store');

  const store = await DB.createStore(newFranchise.id, { name: randomName() });
  const deleteRes = await request(app)
    .delete(`/api/franchise/${newFranchise.id}/store/${store.id}`)
    .set('Authorization', `Bearer ${testUserAuthToken}`)
  
  expect(deleteRes.status).toBe(403);
  expect(deleteRes.body.message).toBe('unable to delete a store');
  await DB.deleteStore(newFranchise.id, store.id);
  await DB.deleteFranchise(newFranchise.id);
})

test('getUserFranchises', async () => {
  const { franchise: newFranchise, franchisee: newFranchisee } = await createFullFranchise();

  const loginRes = await request(app).put('/api/auth').send(newFranchisee);
  expect(loginRes.status).toBe(200);
  expectValidJwt(loginRes.body.token);

  const getUserFranchisesRes = await request(app)
    .get(`/api/franchise/${newFranchisee.id}`)
    .set('Authorization', `Bearer ${loginRes.body.token}`)
  
  expect(getUserFranchisesRes.status).toBe(200);
  expect(getUserFranchisesRes.body).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: newFranchise.id, name: newFranchise.name }),
  ]));
  await DB.deleteFranchise(newFranchise.id);
})

//User tests

test('Update user', async () => {
  const updateRequest = {
    name: 'New Name',
    email: `${randomName()}@example.com`,
    password: 'newPassword123',
  };
  const updateRes = await request(app)
    .put(`/api/user/${testUser.id}`)
    .set('Authorization', `Bearer ${testUserAuthToken}`)
    .send(updateRequest)
  
  expect(updateRes.status).toBe(200);
  expect(updateRes.body.user).toMatchObject({
    id: testUser.id,
    name: updateRequest.name,
    email: updateRequest.email,
    roles: [expect.objectContaining({ role: Role.Diner })],
  });
  expect(updateRes.body.user).not.toHaveProperty('password');
  expectValidJwt(updateRes.body.token);
})

test('Update user not authorized', async () => {
  const updateRequest = {
    name: 'New Name',
    email: `${randomName()}@example.com`,
    password: 'newPassword123',
  };
  const newUser = await createNewUser();
  const loginRes = await request(app).put('/api/auth').send(newUser);
  expect(loginRes.status).toBe(200);
  expectValidJwt(loginRes.body.token);

  const updateRes = await request(app)
    .put(`/api/user/${testUser.id}`)
    .set('Authorization', `Bearer ${loginRes.body.token}`)
    .send(updateRequest)
  
  expect(updateRes.status).toBe(403);
  expect(updateRes.body.message).toBe('unauthorized');
})

test('Get user', async () => {
  const getRes = await request(app)
    .get(`/api/user/me`)
    .set('Authorization', `Bearer ${testUserAuthToken}`)
  
  expect(getRes.status).toBe(200);
  expect(getRes.body).toMatchObject({
    id: testUser.id,
    name: testUser.name,
    email: testUser.email,
    roles: [expect.objectContaining({ role: Role.Diner })],
  });
  expect(getRes.body).not.toHaveProperty('password');
})

function expectValidJwt(potentialJwt) {
  expect(potentialJwt).toMatch(/^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/);
}



