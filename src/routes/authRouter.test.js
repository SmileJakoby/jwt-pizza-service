const request = require('supertest');
const app = require('../service');
const { Role, DB } = require('../database/database.js');

const createdUserIds = new Set();
const createdFranchiseIds = new Set();
const createdMenuItemIds = new Set();
const createdOrderIds = new Set();


function randomName() {
  return Math.random().toString(36).substring(2, 12);
}

function trackNewMenuItems(existingItems, currentItems) {
  const existingIds = new Set(existingItems.map((item) => item.id));
  for (const item of currentItems) {
    if (!existingIds.has(item.id)) {
      createdMenuItemIds.add(item.id);
    }
  }
}

if (process.env.VSCODE_INSPECTOR_OPTIONS) {
  jest.setTimeout(60 * 1000 * 5); // 5 minutes
}


async function createAdminUser() {
  let user = { password: 'toomanysecrets', roles: [{ role: Role.Admin }] };
  user.name = randomName();
  user.email = user.name + '@admin.com';

  user = await DB.addUser(user);
  createdUserIds.add(user.id);
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
  createdUserIds.add(user.id);
  return { ...user, password: 'toomanysecrets' };
}

async function createFranchise(adminEmail) {
  const franchise = await DB.createFranchise({
    name: randomName(),
    admins: [{ email: adminEmail }],
  });
  createdFranchiseIds.add(franchise.id);
  return franchise;
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
  if (registerRes.body.user?.id) {
    createdUserIds.add(registerRes.body.user.id);
  }
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

afterEach(async () => {
  if (createdUserIds.size === 0 && createdFranchiseIds.size === 0 &&
      createdMenuItemIds.size === 0 && createdOrderIds.size === 0) {
    return;
  }

  const connection = await DB.getConnection();
  try {
    for (const franchiseId of createdFranchiseIds) {
      await DB.query(connection, 'DELETE FROM store WHERE franchiseId=?', [franchiseId]);
      await DB.query(connection, 'DELETE FROM userRole WHERE objectId=?', [franchiseId]);
      await DB.query(connection, 'DELETE FROM franchise WHERE id=?', [franchiseId]);
    }

    if (createdOrderIds.size > 0) {
      const orderIds = [...createdOrderIds];
      const placeholders = orderIds.map(() => '?').join(', ');
      await DB.query(connection, `DELETE FROM orderItem WHERE orderId IN (${placeholders})`, orderIds);
      await DB.query(connection, `DELETE FROM dinerOrder WHERE id IN (${placeholders})`, orderIds);
    }

    for (const menuItemId of createdMenuItemIds) {
      await DB.query(connection, 'DELETE FROM menu WHERE id=?', [menuItemId]);
    }

    if (createdUserIds.size > 0) {
      const userIds = [...createdUserIds];
      const placeholders = userIds.map(() => '?').join(', ');
      await DB.query(connection, `DELETE FROM auth WHERE userId IN (${placeholders})`, userIds);
      await DB.query(connection, `DELETE FROM userRole WHERE userId IN (${placeholders})`, userIds);
      await DB.query(connection, `DELETE FROM user WHERE id IN (${placeholders})`, userIds);
    }
  } finally {
    connection.end();
    createdUserIds.clear();
    createdFranchiseIds.clear();
    createdMenuItemIds.clear();
    createdOrderIds.clear();
  }
});

afterAll(async () => {
  if (!testUser.id) {
    return;
  }

  const connection = await DB.getConnection();
  try {
    await DB.query(connection, 'DELETE FROM auth WHERE userId=?', [testUser.id]);
    await DB.query(connection, 'DELETE FROM userRole WHERE userId=?', [testUser.id]);
    await DB.query(connection, 'DELETE FROM user WHERE id=?', [testUser.id]);
  } finally {
    connection.end();
  }
});

test('login', async () => {
  const loginRes = await request(app).put('/api/auth').send(testUser);
  expect(loginRes.status).toBe(200);
  expectValidJwt(loginRes.body.token);

  const expectedUser = { ...testUser, roles: [{ role: 'diner' }] };
  delete expectedUser.password;
  expect(loginRes.body.user).toMatchObject(expectedUser);
});

test('default admin login returns admin role', async () => {
  const loginRes = await request(app)
    .put('/api/auth')
    .send({ email: 'a@jwt.com', password: 'admin' });

  expect(loginRes.status).toBe(200);
  expect(loginRes.body.user.roles).toEqual(
    expect.arrayContaining([expect.objectContaining({ role: Role.Admin })])
  );

  const logoutRes = await request(app)
    .delete('/api/auth')
    .set('Authorization', `Bearer ${loginRes.body.token}`);
  expect(logoutRes.status).toBe(200);
});


//Order tests

test('createOrder', async () => {
  const menuRes = await request(app).get('/api/order/menu');
  expect(menuRes.status).toBe(200);

  const menuItem = {
    title: 'Veggie',
    image: 'pizza1.png',
    price: 0.0038,
    description: 'A garden of delight',
  };
  let orderMenuItem = menuRes.body.find((item) => item.title === menuItem.title && Number(item.price) === menuItem.price);
  if (!orderMenuItem) {
    const adminLoginRes = await loginAdminUser();
    const addRes = await request(app)
      .put('/api/order/menu')
      .set('Authorization', `Bearer ${adminLoginRes.body.token}`)
      .send(menuItem);
    if (Array.isArray(addRes.body)) {
      trackNewMenuItems(menuRes.body, addRes.body);
    }
    expect(addRes.status).toBe(200);
    orderMenuItem = addRes.body.find((item) => item.title === menuItem.title && Number(item.price) === menuItem.price);
  }
  expect(orderMenuItem).toBeDefined();

  const testOrder = {
    franchiseId: 1,
    storeId: 1,
    items: [{ menuId: orderMenuItem.id, description: orderMenuItem.title, price: Number(orderMenuItem.price) }],
  };
  const orderRes = await request(app)
    .post('/api/order')
    .set('Authorization', `Bearer ${testUserAuthToken}`)
    .send(testOrder);
  if (orderRes.body.order?.id) {
    createdOrderIds.add(orderRes.body.order.id);
  }
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
  const menuBeforeRes = await request(app).get('/api/order/menu');
  expect(menuBeforeRes.status).toBe(200);
  const adminLoginRes = await loginAdminUser();
  const addRes = await request(app)
    .put('/api/order/menu')
    .set('Authorization', `Bearer ${(adminLoginRes).body.token}`)
    .send(newItem);
  if (Array.isArray(addRes.body)) {
    trackNewMenuItems(menuBeforeRes.body, addRes.body);
  }
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
  const menuItem = await DB.addMenuItem({
    title: `menu test ${randomName()}`,
    image: 'menu-test.png',
    price: 0.001,
    description: 'Temporary menu item for the menu listing test',
  });
  createdMenuItemIds.add(menuItem.id);

  const viewRes = await request(app)
    .get('/api/order/menu');
  expect(viewRes.status).toBe(200);
  expect(Array.isArray(viewRes.body)).toBe(true);
  expect(viewRes.body).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: menuItem.id,
      title: menuItem.title,
      image: menuItem.image,
      price: menuItem.price,
      description: menuItem.description,
    }),
  ]));
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
  if (createRes.body.id) {
    createdFranchiseIds.add(createRes.body.id);
  }
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

test('list users unauthorized', async () => {
  const listUsersRes = await request(app).get('/api/user');
  expect(listUsersRes.status).toBe(401);
});

test('list users', async () => {
  const userName = `pizza diner ${randomName()}`;
  const [user] = await registerUser(request(app), userName);
  const [secondUser] = await registerUser(request(app), userName);
  const adminLoginRes = await loginAdminUser();
  expect(adminLoginRes.status).toBe(200);
  const listUsersRes = await request(app)
    .get('/api/user')
    .query({ page: 1, limit: 1, name: userName })
    .set('Authorization', 'Bearer ' + adminLoginRes.body.token);
  expect(listUsersRes.status).toBe(200);
  expect(listUsersRes.body.more).toBe(true);
  expect(listUsersRes.body.users).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: expect.any(Number),
      name: user.name,
      email: user.email,
      roles: expect.arrayContaining([
        expect.objectContaining({ role: Role.Diner }),
      ]),
    }),
  ]));
  expect(listUsersRes.body.users[0]).not.toHaveProperty('password');

  const nextPageRes = await request(app)
    .get('/api/user')
    .query({ page: 2, limit: 1, name: userName })
    .set('Authorization', 'Bearer ' + adminLoginRes.body.token);
  expect(nextPageRes.status).toBe(200);
  expect(nextPageRes.body.more).toBe(false);
  expect(nextPageRes.body.users).toEqual([
    expect.objectContaining({
      id: secondUser.id,
      name: secondUser.name,
      email: secondUser.email,
    }),
  ]);
});

test('list users not authorized for non-admin', async () => {
  const [, userToken] = await registerUser(request(app));
  const listUsersRes = await request(app)
    .get('/api/user')
    .set('Authorization', `Bearer ${userToken}`);

  expect(listUsersRes.status).toBe(403);
  expect(listUsersRes.body.message).toBe('unauthorized');
});

test('delete user not authorized', async () => {
  const userToDelete = await createNewUser();
  const deleteRes = await request(app)
    .delete(`/api/user/${userToDelete.id}`)
    .set('Authorization', `Bearer ${testUserAuthToken}`);

  expect(deleteRes.status).toBe(403);
  expect(deleteRes.body.message).toBe('unauthorized');
  const loginRes = await request(app).put('/api/auth').send(userToDelete);
  expect(loginRes.status).toBe(200);
});

test('admin deletes user', async () => {
  const userToDelete = await createNewUser();
  const adminLoginRes = await loginAdminUser();
  expect(adminLoginRes.status).toBe(200);
  const deleteRes = await request(app)
    .delete(`/api/user/${userToDelete.id}`)
    .set('Authorization', `Bearer ${adminLoginRes.body.token}`);

  expect(deleteRes.status).toBe(200);
  expect(deleteRes.body).toEqual({ message: 'user deleted' });

  const loginRes = await request(app).put('/api/auth').send(userToDelete);
  expect(loginRes.status).toBe(404);
});

async function registerUser(service, name = 'pizza diner') {
  const testUser = {
    name,
    email: `${randomName()}@test.com`,
    password: 'a',
  };
  const registerRes = await service.post('/api/auth').send(testUser);
  if (registerRes.body.user?.id) {
    createdUserIds.add(registerRes.body.user.id);
  }
  registerRes.body.user.password = testUser.password;

  return [registerRes.body.user, registerRes.body.token];
}

function expectValidJwt(potentialJwt) {
  expect(potentialJwt).toMatch(/^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/);
}
