const { Datastore } = require('@google-cloud/datastore');
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');

const bodyParser = require('body-parser');
const express = require('express');
const axios = require('axios');
const path = require('path');

const datastore = new Datastore();
const app = express();
const router = express.Router();

app.use(bodyParser.json());

const USER = 'User'; // owner id, *pets*
const PET = 'Pet'; // name, breed, age, *owner*, *school*
const SCH = 'School'; // name, location, headmaster, *students*
const STATE = 'State';
const STATE_LEN = 20;
const PAGE_LIM = 5;
const ERR = 'error';

const ERR400_FULL = { 'Error': 'The request object is missing at least one of the required attributes or at least one of the attributes has an invalid value' };
const ERR400_PART = { 'Error': 'At least one of the attributes in the request object has an invalid value' };
const ERR401 = { 'Error': 'The JWT is missing or invalid' };
const ERR403 = { 'Error': 'The pet belongs to someone else' };
const ERR404_PET = { 'Error': 'No pet with this pet_id exists' };
const ERR404_SCH = { 'Error': 'No school with this school_id exists' };
const ERR406 = { 'Error': 'The requested response type must be application/json' };

const APP_URL = 'https://kima4-cs493-final.ue.r.appspot.com';
const REDIRECT_URI = APP_URL + '/oauth';
const CLIENT_ID = '1030856289367-m2tgvujg454u0uqi0soler8bajl2c3bt.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const oauth2_client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI
);

/* ------------------------------------ Begin Shared Functions ------------------------------------ */

// adds self and id information to output
function from_datastore(item) {
    item.id = parseInt(item[Datastore.KEY].id);
    item['self'] = APP_URL + '/' + item[Datastore.KEY].kind.toLowerCase() + 's/' + item[Datastore.KEY].id;
    return item;
}

// removes self and id information to save to database
function to_datastore(item) {
    delete item.self;
    delete item.id;
    return item;
}

// gets the datastore key associated with the specidied id
function get_key(id, type) {
    const key = datastore.key([type, parseInt(id, 10)]);
    return key;
}

// parses the authorization header for the jwt
function get_jwt(head) {
    if (head) {
        return head.split(' ')[1];
    }
}

// retrieves the item with the specified key from datastore
function get_item(key) {
    return datastore.get(key).then(entity => {
        if (entity[0] == null) {
            return null;
        } else {
            item = entity.map(from_datastore);
            return item[0];
        }
    });
}

// retrieves a list of items of the specified type from datastore
function get_items(type) {
    const q = datastore.createQuery(type);
    return datastore.runQuery(q).then(entity => {
        return entity[0].map(from_datastore);
    });
}

/* ------------------------------------ End Shared Functions ------------------------------------ */

/* ------------------------------------ Begin Authentication/Authorization Model Functions ------------------------------------ */

// generates a value for the state to use in authentication
function gen_state() {
    const key = datastore.key(STATE);

    let state = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	const char_len = chars.length;
	for (let i = 0; i < STATE_LEN; i++) {
		state += chars.charAt(Math.floor(Math.random() * char_len));
	}

	const data = { 'state': state }
	return datastore.save({ 'key': key, 'data': data }).then(() => {
		return state;
	});
}

// gets the list of states from datastore
function get_states() {
    const q = datastore.createQuery(STATE);
    return datastore.runQuery(q).then(entities => {
        let states = [];
        for (let s of entities[0]) {
            states.push(s.state);
        }
        return states;
    });
}

// creates the authorization url to prompt log in
function create_auth_url() {
    return gen_state().then(new_state => {
        const auth_url = oauth2_client.generateAuthUrl({
            scope: 'profile',
            state: new_state
        });
        return auth_url;
    });
}

// checks that the supplied token is valid
function verify_token(token) {
    const client = new OAuth2Client(CLIENT_ID);
    return client.verifyIdToken({
        idToken: token,
        audience: CLIENT_ID
    }).then(ticket => {
        const payload = ticket.getPayload();
        const user_id = 'Owner' + payload['sub'];
        return user_id;
    }).catch(function(error) {
        console.log(error);
        return ERR;
    });
}

/* ------------------------------------ End Authentication/Authorization Model Functions ------------------------------------ */

/* ------------------------------------ Begin Authentication/Authorization Controller Functions ------------------------------------ */

// home page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '/views/index.html'));
});

// login page that redirects to the generated authorization url
app.get('/login', (req, res) => {
    create_auth_url().then(auth_url => {
        res.status(301).redirect(auth_url);
    });
});

// checks the state value and redirects to uer info page if valid
app.get('/oauth', (req, res) => {
    const code = req.query.code;
    const res_state = req.query.state;

    get_states().then(states => {
        if (states.includes(res_state)) {
            oauth2_client.getToken(code).then(entity => {
                oauth2_client.setCredentials(entity.tokens);
                res.status(301).redirect(APP_URL+'/userinfo');
            });
        } else {
            res.status(404).json({ 'Error': 'The returned state value is not valid '});
        }
    });
});

// displays user id and jwt
app.get('/userinfo', (req, res) => {
    verify_token(oauth2_client.credentials.id_token).then(owner_id => {
        if (owner_id != ERR) {
            get_owner_ids().then(users => {
                if (!users.includes(owner_id)) {
                    create_user(owner_id);
                }
                res.render('userInfo.pug', { owner_id: owner_id, jwt: oauth2_client.credentials.id_token });
            });
        } else {
            res.sendFile(path.join(__dirname, '/views/error.html'));
        }
    });
});

/* ------------------------------------ End Authentication/Authorization Controller Functions ------------------------------------ */

/* ------------------------------------ Begin User Model Functions ------------------------------------ */

// gets the list of users from datastore
function get_user_list() {
    return get_items(USER);
}

// gets a list of owner ids
function get_owner_ids() {
    return get_user_list().then(users => {
        let owner_ids = [];
        for (let u of users) {
            owner_ids.push(u.owner_id);
        }
        return owner_ids;
    });
}

// creates a new user instance in datastore
function create_user(user_id) {
    const key = datastore.key(USER);
    const new_user = { 'owner_id': user_id, 'pets': [] };

    return datastore.save({ 'key': key, 'data': new_user }).then(() => {
        return new_user;
    });
}

// gets a list of user information to display on /users
function get_users() {
    return get_user_list().then(users => {
        users = users.map(to_datastore);
        for (let u of users) {
            const num_pets = u.pets.length;
            u['num_pets'] = num_pets;
            delete u.pets;
        }
        return users;
    });
}

// finds a specific user based on the owner id
function get_user(owner_id) {
    const q = datastore.createQuery(USER).filter('owner_id', '=', owner_id);
    return datastore.runQuery(q).then(entity => {
        if (entity[0] == null) {
            return null;
        } else {
            if (entity[0][0] == null) {
                return null;
            } else {
                return from_datastore(entity[0][0]);
            }
        }
    });
}

// adds the pet id to the pet list of a specified owner
function add_pet_to_owner(owner_id, pet_id) {
    return get_user(owner_id).then(user => {
        user.pets.push(parseInt(pet_id));
        key = get_key(user.id, USER);
        user = to_datastore(user);
        return datastore.save({ 'key': key, 'data': user });
    });
}

// removes the pet from the pet list of its owner
function delete_pet_from_owner(pet_key) {
    return get_item(pet_key).then(pet => {
        return get_user(pet.owner).then(user => {
            const new_pet_list = user.pets.filter(p => p != pet_key['id']);
            user.pets = new_pet_list;
            user_key = get_key(user.id, USER);
            user = to_datastore(user);
            return datastore.save({ 'key': user_key, 'data': user });
        });
    });
}

// adds pet information for the owner as needed
async function expand_owner(user) {
    delete user.id;
    user['self'] = APP_URL + '/users/' + user.owner_id;
    let pet_list = [];
    for (let p of user.pets) {
        let pet = await get_pet(parseInt(p));
        delete pet.owner;
        pet_list.push(pet);
    }
    user.pets = pet_list;
    return user;
}

/* ------------------------------------ End User Model Functions ------------------------------------ */

/* ------------------------------------ Begin User Controller Functions ------------------------------------ */

// POST to /users is not allowed
router.post('/users', function (req, res) {
    res.set('Accept', 'GET');
    res.status(405).end();
});

// GET to /users returns a list of registered users
app.get('/users', (req, res) => {
    const accepts = req.accepts(['application/json']);
    if (!accepts) {
        res.status(406).json(ERR406);
    }
    get_users().then(users => {
        res.status(200).json(users);
    });
});

// GET to /users/:owner_id returns information about the user
app.get('/users/:owner_id', (req, res) => {
    const accepts = req.accepts(['application/json']);
    if (!accepts) {
        res.status(406).json(ERR406);
    }
    const jwt = get_jwt(req.headers.authorization);
    verify_token(jwt).then(owner_id => {
        if (owner_id != ERR) {
            if (owner_id != req.params.owner_id) {
                res.status(403).json({ 'Error': 'You cannot view another user\'s information page'});
            } else {
                get_user(req.params.owner_id).then(user => {
                    expand_owner(user).then(expanded_owner => {
                        res.status(200).json(expanded_owner);
                    });
                });
            }
        } else {
            res.status(401).json(ERR401);
        }
    });
});

// PATCH to /users is not allowed
router.patch('/users', function (req, res) {
    res.set('Accept', 'GET');
    res.status(405).end();
});

// PUT to /users is not allowed
router.put('/users', function (req, res) {
    res.set('Accept', 'GET');
    res.status(405).end();
});

// DELETE to /users is not allowed
router.delete('/users', function (req, res) {
    res.set('Accept', 'GET');
    res.status(405).end();
});

/* ------------------------------------ End User Controller Functions ------------------------------------ */

/* ------------------------------------ Begin Validation Functions ------------------------------------ */

// checks if supplied variable is a string and if its contents are valid
function check_string(str, min, max) {
    if (typeof str === 'string' || str instanceof String) {
        if (str.length > min && str.length < max) {
            return /^[A-Za-z -'.]*$/.test(str);
        }
    }
    return false;
}

// checks if supplied variable is a string and if its contents are valid
function check_string_num(str, min, max) {
    if (typeof str === 'string' || str instanceof String) {
        if (str.length > min && str.length < max) {
            return /^[A-Za-z0-9 -',.]*$/.test(str);
        }
    }
    return false;
}

// checks if the supplied variable is a number and if its contents are valid
function check_num(num, min, max) {
    if (typeof num === 'number') {
        if (num >= min && num <= max) {
            return true;
        }
    }
    return false;
}

// checks if the name is valid
function name_valid(name) {
    return check_string(name, 1, 50);
}

// checks if the breed is valid
function breed_valid(breed) {
    return check_string(breed, 1, 30);
}

// checks if the age is valid
function age_valid(age) {
    return check_num(age, 0, 150);
}

// checks if the school name is valid
function school_name_valid(name) {
    return check_string_num(name, 1, 50);
}

// checks if the location is valid
function location_valid(location) {
    return check_string_num(location, 1, 80);
}

// checks if the headmaster is valid
function headmaster_valid(headmaster) {
    return check_string(headmaster, 1, 50);
}

// checks vartypes of all attributes for pets
function check_vartypes_pet(name, breed, age) {
    if (name_valid(name) && breed_valid(breed) && age_valid(age)) {
        return true;
    } else {
        return false;
    }
}

// check vartypes of supplied attributes for pets
function check_some_vartypes_pet(name = 'default', breed = 'default', age = 10) {
    return check_vartypes_pet(name, breed, age);
}

// checks vartypes of all attributes for schools
function check_vartypes_school(name, location, headmaster) {
    if (school_name_valid(name) && location_valid(location) && headmaster_valid(headmaster)) {
        return true;
    } else {
        return false;
    }
}

// check vartypes of supplied attributes for schools
function check_some_vartypes_school(name = 'default', location = 'default', headmaster = 'default') {
    return check_vartypes_school(name, location, headmaster);
}

/* ------------------------------------ End Validation Functions ------------------------------------ */

/* ------------------------------------ Begin Pet Model Functions ------------------------------------ */

// adds a pet to the database
function post_pet(name, breed, age, owner_id) {
    const key = datastore.key(PET);
    const new_pet = { 'name': name, 'breed': breed, 'age': age, 'owner': owner_id, 'school': null };

    return datastore.save({ 'key': key, 'data': new_pet }).then(() => {
        return add_pet_to_owner(owner_id, key['id']).then(() => {
            return get_pet(key['id']).then(pet => {
                return pet;
            });
        });
    });
}

// gets a pet from the database
function get_pet(pet_id) {
    const key = get_key(pet_id, PET);
    return get_item(key).then(pet => {
        return pet;
    });
}

// gets a paginated list of the specified owner's pets
function get_pets(owner_id, page) {
    const q = datastore.createQuery(PET).filter('owner', '=', owner_id);
    return datastore.runQuery(q).then(entities => {
        let pets = entities[0].map(from_datastore);
        const total_pets = pets.length;
        const start_num = (page - 1) * PAGE_LIM;
        if (start_num > 0) {
            pets.splice(0, start_num);
        }
        let next_page = false;
        if (pets.length > PAGE_LIM) {
            pets = pets.splice(0, PAGE_LIM);
            next_page = true;
        }
        let pet_collection = { 'pets': pets, 'total_pets': total_pets };
        if (next_page) {
            pet_collection['next'] = APP_URL + '/pets?page=' + (page + 1);
        }
        return pet_collection;
    });
}

// patches a pet
function patch_pet(name, breed, age, pet) {
    if (name == undefined) {
        name = pet.name;
    }
    if (breed == undefined) {
        breed = pet.breed;
    }
    if (age == undefined) {
        age = pet.age;
    }
    return put_pet(name, breed, age, pet);
}

// puts a pet
function put_pet(name, breed, age, pet) {
    const key = get_key(pet.id, PET);
    const updated_pet = { 'name': name, 'breed': breed, 'age': age, 'owner': pet.owner, 'school': pet.school };
    return datastore.save({ 'key': key, 'data': updated_pet }).then(() => {
        return get_pet(key['id']).then(pet => {
            return pet;
        });
    });
}

// deletes a pet from the database
function delete_pet(pet_id, pet) {
    const pet_key = get_key(pet_id, PET);
    return delete_pet_from_owner(pet_key).then(() => {
        if (pet.school != null) {
            return get_school(pet.school.id, pet).then(school => {
                return unenroll_from_school(pet_id, pet.school.id, pet, school).then(() => {
                    return datastore.delete(pet_key);
                });
            });
        } else {
            return datastore.delete(pet_key);
        }
    });
}

// sets the school attribute of a pet to null
function unenroll_pet(pet_id) {
    const pet_key = get_key(pet_id, PET);
    return get_pet(pet_id).then(pet => {
        pet.school = null;
        pet = to_datastore(pet);
        return datastore.save({ 'key': pet_key, 'data': pet });
    });
}

/* ------------------------------------ End Pet Model Functions ------------------------------------ */

/* ------------------------------------ Begin Pet Controller Functions ------------------------------------ */

// POST to /pets adds a specified pet
router.post('/pets', function (req, res) {
    const accepts = req.accepts(['application/json']);
    if (!accepts) {
        res.status(406).json(ERR406);
    } else {
        const jwt = get_jwt(req.headers.authorization);
        verify_token(jwt).then(owner_id => {
            if (owner_id != ERR) {
                if (check_vartypes_pet(req.body.name, req.body.breed, req.body.age)) {
                    post_pet(req.body.name, req.body.breed, req.body.age, owner_id).then(pet => {
                        res.status(201).json(pet);
                    });
                } else {
                    res.status(400).json(ERR400_FULL);
                }
            } else {
                res.status(401).json(ERR401);
            }
        });
    }
});

// GET to /pets returns a paginated list of the owner's pets
router.get('/pets', function (req, res) {
    const accepts = req.accepts(['application/json']);
    if (!accepts) {
        res.status(406).json(ERR406);
    }
    const jwt = get_jwt(req.headers.authorization);
    verify_token(jwt).then(owner_id => {
        if (owner_id != ERR) {
            let page = 1;
            if (req.query.page != undefined) {
                page = parseInt(req.query.page);
            }
            get_pets(owner_id, page).then(pets => {
                res.status(200).json(pets);
            });
        } else {
            res.status(401).json(ERR401);
        }
    });
});

// GET to /pets/:pet_id returns information about the specified pet
router.get('/pets/:pet_id', function (req, res) {
    const accepts = req.accepts(['application/json']);
    if (!accepts) {
        res.status(406).json(ERR406);
    }
    const jwt = get_jwt(req.headers.authorization);
    verify_token(jwt).then(owner_id => {
        if (owner_id != ERR) {
            get_pet(req.params.pet_id).then(pet => {
                if (pet == null) {
                    res.status(404).json(ERR404_PET);
                } else {
                    if (owner_id == pet.owner) {
                        res.status(200).json(pet);
                    } else {
                        res.status(403).json(ERR403);
                    }
                }
            });
        } else {
            res.status(401).json(ERR401);
        }
    });
});

// PATCH to /pets is not allowed
router.patch('/pets', function (req, res) {
    res.set('Accept', 'GET, POST');
    res.status(405).end();
});

// PATCH to /pets/:id updates the specified attributes for the specified pet
router.patch('/pets/:pet_id', function (req, res) {
    const accepts = req.accepts(['application/json']);
    if (!accepts) {
        res.status(406).json(ERR406);
    }
    const jwt = get_jwt(req.headers.authorization);
    verify_token(jwt).then(owner_id => {
        if (owner_id != ERR) {
            get_pet(req.params.pet_id).then(pet => {
                if (pet == null) {
                    res.status(404).json(ERR404_PET);
                } else {
                    if (owner_id == pet.owner) {
                        if (check_some_vartypes_pet(req.body.name, req.body.breed, req.body.age)) {
                            if (req.body.school != undefined) {
                                res.status(400).json({ 'Error': 'PATCH to /pets/:pet_id cannot be used to update the school - use PUT or DELETE to /pets/:pet_id/school/:school_id to modify relationships between pets and schools' });
                            } else if (req.body.owner != undefined) {
                                res.status(400).json({ 'Error': 'The owner of the pet cannot be changed' });
                            } else {
                                patch_pet(req.body.name, req.body.breed, req.body.age, pet).then(patched_pet => {
                                    res.status(200).json(patched_pet);
                                });
                            }
                        } else {
                            res.status(400).json(ERR400_PART);
                        }
                    } else {
                        res.status(403).json(ERR403);
                    }
                }
            });
        } else {
            res.status(401).json(ERR401);
        }
    });
});

// PUT to /pets is not allowed
router.put('/pets', function (req, res) {
    res.set('Accept', 'GET, POST');
    res.status(405).end();
});

// PUT to /pets/:pet_id updates the attributes for the specified pet
router.put('/pets/:pet_id', function (req, res) {
    const accepts = req.accepts(['application/json']);
    if (!accepts) {
        res.status(406).json(ERR406);
    }
    const jwt = get_jwt(req.headers.authorization);
    verify_token(jwt).then(owner_id => {
        if (owner_id != ERR) {
            get_pet(req.params.pet_id).then(pet => {
                if (pet == null) {
                    res.status(404).json(ERR404_PET);
                } else {
                    if (owner_id == pet.owner) {
                        if (check_vartypes_pet(req.body.name, req.body.breed, req.body.age)) {
                            if (req.body.school != undefined) {
                                res.status(400).json({ 'Error': 'PUT to /pets/:pet_id cannot be used to update the school - use PUT or DELETE to /pets/:pet_id/school/:school_id to modify relationships between pets and schools' });
                            } else if (req.body.owner != undefined) {
                                res.status(400).json({ 'Error': 'The owner of the pet cannot be changed' });
                            } else {
                                put_pet(req.body.name, req.body.breed, req.body.age, pet).then(updated_pet => {
                                    res.set('Location', updated_pet.self);
                                    res.status(303).end();
                                });
                            }
                        } else {
                            res.status(400).json(ERR400_FULL);
                        }
                    } else {
                        res.status(403).json(ERR403);
                    }
                }
            });
        } else {
            res.status(401).json(ERR401);
        }
    });
});

// DELETE to /pets is not allowed
router.delete('/pets', function (req, res) {
    res.set('Accept', 'GET, POST');
    res.status(405).end();
});

// DELETE to /pets/:pet_id deletes the specified pet
router.delete('/pets/:pet_id', function (req, res) {
    const accepts = req.accepts(['application/json']);
    if (!accepts) {
        res.status(406).json(ERR406);
    }
    const jwt = get_jwt(req.headers.authorization);
    verify_token(jwt).then(owner_id => {
        if (owner_id != ERR) {
            get_pet(req.params.pet_id).then(pet => {
                if (pet == null) {
                    res.status(404).json(ERR404_PET);
                } else if (pet.owner != owner_id) {
                    res.status(403).json(ERR403);
                }else {
                    delete_pet(req.params.pet_id, pet).then(() => {
                        res.status(204).end();
                    });
                }
            });
        } else {
            res.status(401).json(ERR401);
        }
    });
});

// PUT to /pets/:pet_id/schools/:school_id enrolls the pet in the school
router.put('/pets/:pet_id/schools/:school_id', function (req, res) {
    const err404 = { 'Error': 'The specified pet and/or school does not exist' };
    const accepts = req.accepts(['application/json']);
    if (!accepts) {
        res.status(406).json(ERR406);
    }
    const jwt = get_jwt(req.headers.authorization);
    verify_token(jwt).then(owner_id => {
        if (owner_id != ERR) {
            get_pet(req.params.pet_id).then(pet => {
                if (pet == null) {
                    res.status(404).json(err404);
                } else if (pet.owner != owner_id) {
                    res.status(403).json(ERR403);
                } else if (pet.school != null) {
                    res.status(403).json({ 'Error': 'The pet is already enrolled at a school' });
                } else {
                    get_school(req.params.school_id).then(school => {
                        if (school == null) {
                            res.status(404).json(err404);
                        } else {
                            enroll_in_school(req.params.pet_id, req.params.school_id, pet, school).then(() => {
                                res.status(204).end();
                            });
                        }
                    });
                }
            });
        } else {
            res.status(401).json(ERR401);
        }
    });
});

// DELETE to /pets/:pet_id/schools/:school_id unenrolls the pet from the school
router.delete('/pets/:pet_id/schools/:school_id', function (req, res) {
    const err404 = { 'Error': 'No pet with this pet_id is enrolled at a school with this school_id' };
    const accepts = req.accepts(['application/json']);
    if (!accepts) {
        res.status(406).json(ERR406);
    }
    const jwt = get_jwt(req.headers.authorization);
    verify_token(jwt).then(owner_id => {
        if (owner_id != ERR) {
            get_pet(req.params.pet_id).then(pet => {
                if (pet == null) {
                    res.status(404).json(err404);
                } else if (pet.owner != owner_id) {
                    res.status(403).json(ERR403);
                } else {
                    get_school(req.params.school_id).then(school => {
                        if (school == null) {
                            res.status(404).json(err404);
                        } else {
                            if (pet.school.id != school.id) {
                                res.status(404).json(err404);
                            } else {
                                unenroll_from_school(req.params.pet_id, req.params.school_id, pet, school).then(() => {
                                    res.status(204).end();
                                });
                            }
                        }
                    });
                }
            });
        } else {
            res.status(401).json(ERR401);
        }
    });
});

/* ------------------------------------ End Pet Controller Functions ------------------------------------ */

/* -------------------------------- Begin School Model Functions -------------------------------- */

// adds a school to the database
function post_school(name, location, headmaster) {
    const key = datastore.key(SCH);
    const new_school = { 'name': name, 'location': location, 'headmaster': headmaster, 'students': [] };

    return datastore.save({ 'key': key, 'data': new_school }).then(() => {
        return get_school(key['id']).then(school => {
            return school;
        });
    });
}

// gets a school from the database
function get_school(school_id) {
    const key = get_key(school_id, SCH);
    return get_item(key).then(school => {
        return school;
    });
}

// gets a paginated list of schools
function get_schools(page) {
    return get_items(SCH).then(schools => {
        const total_schools = schools.length;
        const start_num = (page - 1) * PAGE_LIM;
        if (start_num > 0) {
            schools.splice(0, start_num);
        }
        let next_page = false;
        if (schools.length > PAGE_LIM) {
            schools = schools.splice(0, PAGE_LIM);
            next_page = true;
        }
        let school_collection = { 'schools': schools, 'total_schools': total_schools };
        if (next_page) {
            school_collection['next'] = APP_URL + '/schools?page=' + (page + 1);
        }
        return school_collection;
    });
}

// patches a school
function patch_school(name, location, headmaster, school) {
    if (name == undefined) {
        name = school.name;
    }
    if (location == undefined) {
        location = school.location;
    }
    if (headmaster == undefined) {
        headmaster = school.headmaster;
    }
    return put_school(name, location, headmaster, school);
}

// puts a school
function put_school(name, location, headmaster, school) {
    const key = get_key(school.id, SCH);
    const updated_school = { 'name': name, 'location': location, 'headmaster': headmaster, 'students': school.students };
    return datastore.save({ 'key': key, 'data': updated_school }).then(() => {
        return get_school(key['id']).then(school => {
            return school;
        });
    });
}

// deletes a school from the database
async function delete_school(school_id, school) {
    const school_key = get_key(school_id, SCH);
    for (let pet of school.students) {
        await unenroll_pet(pet);
    }
    return datastore.delete(school_key);
}

// enrolls a pet in a school
function enroll_in_school(pet_id, school_id, pet, school) {
    const pet_key = get_key(pet_id, PET);
    const school_key = get_key(school_id, SCH);

    pet.school = { 'id': parseInt(school_id), 'name': school.name };
    school.students.push(parseInt(pet_id));

    pet = to_datastore(pet);
    school = to_datastore(school);

    return datastore.save({ 'key': pet_key, 'data': pet }).then(() => {
        return datastore.save({ 'key': school_key, 'data': school });
    });
}

// removes a pet id from the student list of a specified school
function unenroll_from_school(pet_id, school_id, pet, school) {
    const school_key = get_key(school_id, SCH);

    return unenroll_pet(pet_id).then(() => {
        const new_student_list = school.students.filter(s => s != pet_id);
        school.students = new_student_list;
        school = to_datastore(school);
        return datastore.save({ 'key': school_key, 'data': school });

    });
}

/* -------------------------------- End School Model Functions -------------------------------- */

/* -------------------------------- Begin School Controller Functions -------------------------------- */

// POST to /schools adds a specified school
router.post('/schools', function (req, res) {
    const accepts = req.accepts(['application/json']);
    if (!accepts) {
        res.status(406).json(ERR406);
    } else {
        if (check_vartypes_school(req.body.name, req.body.location, req.body.headmaster)) {
            post_school(req.body.name, req.body.location, req.body.headmaster).then(school => {
                res.status(201).json(school);
            });
        } else {
            res.status(400).json(ERR400_FULL);
        }
    }
});

// GET to /schools returns a paginated list of the schools
router.get('/schools', function (req, res) {
    const accepts = req.accepts(['application/json']);
    if (!accepts) {
        res.status(406).json(ERR406);
    }
    let page = 1;
    if (req.query.page != undefined) {
        page = parseInt(req.query.page);
    }
    get_schools(page).then(schools => {
        res.status(200).json(schools);
    });
});

// GET to /schools/:school_id returns information about the specified school
router.get('/schools/:school_id', function (req, res) {
    const accepts = req.accepts(['application/json']);
    if (!accepts) {
        res.status(406).json(ERR406);
    }
    get_school(req.params.school_id).then(school => {
        if (school == null) {
            res.status(404).json(ERR404_SCH);
        } else {
            res.status(200).json(school);
        }
    });
});

// PATCH to /schools is not allowed
router.patch('/schools', function (req, res) {
    res.set('Accept', 'GET, POST');
    res.status(405).end();
});

// PATCH to /schools/:school_id updates the specified attributes for the specified school
router.patch('/schools/:school_id', function (req, res) {
    const accepts = req.accepts(['application/json']);
    if (!accepts) {
        res.status(406).json(ERR406);
    }
    get_school(req.params.school_id).then(school => {
        if (school == null) {
            res.status(404).json(ERR404_SCH);
        } else {
            if (check_some_vartypes_school(req.body.name, req.body.location, req.body.headmaster)) {
                if (req.body.students != undefined) {
                    res.status(400).json({ 'Error': 'PATCH to /schools/:school_id cannot be used to update the students - use PUT or DELETE to /pets/:pet_id/school/:school_id to modify relationships between pets and schools' });
                } else {
                    patch_school(req.body.name, req.body.location, req.body.headmaster, school).then(patched_school => {
                        res.status(200).json(patched_school);
                    });
                }
            } else {
                res.status(400).json(ERR400_PART);
            }
        }
    });
});

// PUT to /schools is not allowed
router.put('/schools', function (req, res) {
    res.set('Accept', 'GET, POST');
    res.status(405).end();
});
// PUT to /schools/:school_id updates the attributes for the specified school
router.put('/schools/:school_id', function (req, res) {
    const accepts = req.accepts(['application/json']);
    if (!accepts) {
        res.status(406).json(ERR406);
    }
    get_school(req.params.school_id).then(school => {
        if (school == null) {
            res.status(404).json(ERR404_SCH);
        } else {
            if (check_vartypes_school(req.body.name, req.body.location, req.body.headmaster)) {
                if (req.body.students != undefined) {
                    res.status(400).json({ 'Error': 'PUT to /schools/:school_id cannot be used to update the students - use PUT or DELETE to /pets/:pet_id/school/:school_id to modify relationships between pets and schools' });
                } else {
                    put_school(req.body.name, req.body.location, req.body.headmaster, school).then(updated_school => {
                        res.set('Location', updated_school.self);
                        res.status(303).end();
                    });
                }
            } else {
                res.status(400).json(ERR400_FULL);
            }
        }
    });
});

// DELETE to /schools is not allowed
router.delete('/schools', function (req, res) {
    res.set('Accept', 'GET, POST');
    res.status(405).end();
});

// DELETE to /schools/:school_id deletes the specified school
router.delete('/schools/:school_id', function (req, res) {
    const accepts = req.accepts(['application/json']);
    if (!accepts) {
        res.status(406).json(ERR406);
    }
    get_school(req.params.school_id).then(school => {
        if (school == null) {
            res.status(404).json(ERR404_SCH);
        } else {
            delete_school(req.params.school_id, school).then(() => {
                res.status(204).end();
            });
        }
    });
});

/* -------------------------------- End School Controller Functions -------------------------------- */

app.use('/', router);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}...`);
});