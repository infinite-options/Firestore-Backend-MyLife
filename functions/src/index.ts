import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

admin.initializeApp();
const fs = require('fs');
//const axios = require('axios');
const {google} = require('googleapis');

const OAuth2Client = google.auth.OAuth2
const credentials_url = 'credentials.json';
const db = admin.firestore();
const redirect_uri = "https://developers.google.com/oauthplayground";

export const GetUserFromEmail = functions.https.onRequest( async (request, response) => {
    let found = false
    const emailID = request.body.email.toString();
    console.log('Email ID sent:', emailID);
    let result: {
        userId: string
    }
    db.collection('users').get()
    .then((snapshot) => {
        snapshot.forEach(doc => {
            if (doc.data()["email_id"] !== undefined && doc.data()["email_id"] === emailID) {   
                console.log('Found')
                found = true 
                result = {
                    userId: doc.id
                }
                response.status(200).send(result);
            }
        })
        if (!found) {
            console.log('Given email ID not found.');
            result = {
                userId: ""
            }
            response.status(404).send(result);
        }
    })
    .catch((error) => {
        console.log('Error in getting collection.');
        result = {
            userId: ""
        }
        response.status(500).send(result);
    });
});

export const NotificationListener = functions
    .firestore
    .document('users/{userId}')
    .onUpdate( async (change, context) => {

        const userId = context.params.userId.toString();
        const newVal = change.after.data();
        const prevVal = change.before.data();

        let updateFlag = false;
        console.log('User ID:', userId);

        let i;
        for(i=0; i<newVal['goals&routines'].length; i++){
            
            if (newVal['goals&routines'].length !== prevVal['goals&routines'].length ||
                newVal['goals&routines'][i].is_available !== prevVal['goals&routines'][i].is_available ||
                newVal['goals&routines'][i].is_complete !== prevVal['goals&routines'][i].is_complete || 
                newVal['goals&routines'][i].is_in_progress !== prevVal['goals&routines'][i].is_in_progress || 
                newVal['goals&routines'][i].is_displayed_today !== prevVal['goals&routines'][i].is_displayed_today || 
                JSON.stringify(newVal['goals&routines'][i].user_notifications) !== JSON.stringify(prevVal['goals&routines'][i].user_notifications)){

                console.log('Setting updateFlag to true because goal:', JSON.stringify(newVal['goals&routines'][i].title));
                updateFlag = true;
                break;
            }
        }
        if(updateFlag){
            if(!newVal.device_token){
                console.log("User has no registered devices. Aborting.");
                return;
            }
            const deviceTokens = newVal.device_token;
            console.log('There are', deviceTokens.length, 'tokens to send notifications to.');
            
            const message = {
                data: {
                    id: userId
                },
                apns: {
                    headers: {
                       "apns-priority": "5",
                       "apns-push-type": "background"
                    },
                    payload: {
                        aps: {
                            "content-available": "1",
                            "data": {
                                "id": userId
                            }
                        }
                    }
                },
                tokens: deviceTokens
            }

            console.log(JSON.stringify(message));
            const responses = await admin.messaging().sendMulticast(message);
            console.log('Success count', responses.successCount);
            console.log('Failure count', responses.failureCount);
            let validTokens: string[] = []
            responses.responses.forEach((response, index) => {
                const error = response.error;
                if(error) {
                    console.error('Failure sending notification to', deviceTokens[index]);
                    console.log(error);
                    if (error.code === 'messaging/invalid-registration-token' ||
                        error.code === 'messaging/registration-token-not-registered' ||
                        error.code === 'messaging/invalid-argument') {
                            console.log('token not registered: ', deviceTokens[index])
                    }
                }
                if(response.success){
                    validTokens.push(deviceTokens[index])
                }
            });
             return db.collection("users").doc(userId).update({ "device_token": validTokens })
                .then((response) => {
                    console.log('Updated device tokens');
                })
                .catch((error) => {
                    console.log('error in', userId);
                });
        }
});


export const SaveDeviceToken = functions.https.onRequest( async (req, res) =>{
    const userId = req.body.userId.toString();
    const deviceToken = req.body.deviceToken.toString();
  
    const user = db.collection('users').doc(userId);
  
    user.get()
    .then( async doc => {
        if (!doc.exists) {
            console.log('No such document!');
            res.status(500).send("Unable to find document")
        }
        else{
            const userInfo = doc.data()!;
            console.log(typeof userInfo);
            if(!userInfo['device_token']){
                userInfo.device_token = [];
                console.log("Creating device_token array");
            }
            console.log("Pushing into device_token array");
            //console.log(typeof userInfo['device_token']);
            let duplicate = false;
            userInfo['device_token'].forEach( (token: String)=>{
                if (token === deviceToken) {
                    duplicate = true;
                    console.log("Token already exists. Exiting");
                    res.status(200).send("Token already exists.");
                }
            });

            if (!duplicate){
                userInfo['device_token'].push(deviceToken);
                await db.collection("users").doc(userId).update({ "device_token": userInfo['device_token'] })
                    .then((response) => {
                        console.log('Updated device tokens');
                        res.status(200).send("Succesfully inserted");
                    })
                    .catch((error) => {
                        console.log('error in', userId);
                        res.status(500).send("Error in inserting device token.")
                    });
            }
        }
    })
    .catch(error =>{
      console.log(error)
      res.status(500).send("Some problem occurred. Try again.")
    })
});

exports.StartGoalOrRoutine = functions.https.onCall(async (data, context) => {

    //Grab the text parameter.
    const userId = data.userId?.toString();
    const routineId = data.routineId?.toString();
    const routineNumberReq = data.routineNumber?.toString();
    let routineNumber;

    if (userId && routineId && routineNumberReq) {
        const user = db.collection('users').doc(userId);

        //Using a promise here since 'onCall' is async.
        return user.get()
            .then(doc => {
                if (!doc.exists) {
                    console.log('No such document!');
                    return 404;
                }
                else {
                    routineNumber = parseInt(routineNumberReq);
                    const routines = doc.data()!;
                    // console.log('Document data:', doc.data());
                    if (routines['goals&routines'].length>routineNumber && routines['goals&routines'][routineNumber].id === routineId) {
                        routines['goals&routines'][routineNumber].is_in_progress = true;
                        routines['goals&routines'][routineNumber].datetime_started = getCurrentDateTimeUTC();
                        user.set(routines).then().catch();
                        console.log('Success');
                        return 200;
                    }
                    else {
                        for (let i = 0; i < routines['goals&routines'].length; i++) {
                            if (routines['goals&routines'][i].id === routineId) {
                                routines['goals&routines'][i].is_in_progress = true;
                                routines['goals&routines'][i].datetime_started = getCurrentDateTimeUTC();
                                user.set(routines).then().catch();
                                console.log('Success');
                                return 200;
                            }
                        }
                    }
                  return 404;
                }
            })
            .catch(err => {
            console.log('Error getting document', err);
            return 400;
        });
    }
    else{
      return 400;
    }
});

exports.StartActionOrTask = functions.https.onCall( async (data, context) => {

    //Grab the text parameter.
    const userId = data.userId?.toString();
    const routineId = data.routineId?.toString();
    const taskId = data.taskId?.toString();
    const taskNumberReq = data.taskNumber?.toString();
    let taskNumber;

    if (userId && routineId && taskId && taskNumberReq) {
        const routine = db.collection('users').doc(userId).collection('goals&routines').doc(routineId);

        //Using a promise here since 'onCall' is async.
        return routine.get()
          .then(doc => {
              if (!doc.exists) {
                  console.log('No such document!');
                  return 404;
              }
                else {
                    taskNumber = parseInt(taskNumberReq);
                    const tasks = doc.data()!;
                    if (tasks['actions&tasks'].length>taskNumber && tasks['actions&tasks'][taskNumber].id === taskId) {
                        tasks['actions&tasks'][taskNumber].is_in_progress = true;
                        tasks['actions&tasks'][taskNumber].datetime_started = getCurrentDateTimeUTC();
                        routine.set(tasks).then().catch();
                        console.log('Success');
                        return 200;
                    }
                    else {
                        for (let i = 0; i < tasks['actions&tasks'].length; i++) {
                            if (tasks['actions&tasks'][i].id === taskId) {
                                tasks['actions&tasks'][i].is_in_progress = true;
                                tasks['actions&tasks'][i].datetime_started = getCurrentDateTimeUTC();
                                routine.set(tasks).then().catch();
                                console.log('Success');
                                return 200;
                            }
                        }
                    }
                  return 404;
                }
            })
            .catch(err => {
            console.log('Error getting document', err);
            return 400;
        });
    }
    else{
      return 400;
    }
});

export const StartInstructionOrStep = functions.https.onCall( async (data, context) => {

    // Grab the text parameter.
    const userId = data.userId?.toString();
    const routineId = data.routineId?.toString();
    const taskId = data.taskId?.toString();
    const stepNumberReq = data.stepNumber?.toString();
    let stepNumber;
  
    if (userId && routineId && taskId && stepNumberReq) {
      const task = db.collection('users').doc(userId).collection('goals&routines').doc(routineId).collection('actions&tasks').doc(taskId);
  
      //Using a promise here since 'onCall' is async.
      return task.get()
        .then(doc => {
          if (!doc.exists) {
            console.log('No such document!');
            return 404;
          }
          else {
            stepNumber = parseInt(stepNumberReq)
            const steps = doc.data()!;
            steps['instructions&steps'][stepNumber].is_in_progress = true;
            steps['instructions&steps'][stepNumber].datetime_started = getCurrentDateTimeUTC()
            task.set(steps).then().catch();
            console.log('Success');
            return 200;
          }
        })
        .catch(err => {
          console.log('Error getting document', err);
          return 400;
        });
    }
    else{
      return 400;
    }
});

exports.CompleteGoalOrRoutine = functions.https.onCall( async (data, context) => {

    //Grab the text parameter.
    const userId = data.userId?.toString();
    const routineId = data.routineId?.toString();
    const routineNumberReq = data.routineNumber?.toString();
    let routineNumber;

    if (userId && routineId && routineNumberReq) {
        const user = db.collection('users').doc(userId);

        //Using a promise here since 'onCall' is async.
        return user.get()
            .then(doc => {
                if (!doc.exists) {
                    console.log('No such document!');
                    return 404;
                }
                else {
                    routineNumber = parseInt(routineNumberReq);
                    const routines = doc.data()!;
                    if (routines['goals&routines']>routineNumber && routines['goals&routines'][routineNumber].id === routineId) {
                        routines['goals&routines'][routineNumber].is_in_progress = false;
                        routines['goals&routines'][routineNumber].is_complete = true;
                        routines['goals&routines'][routineNumber].datetime_completed = getCurrentDateTimeUTC();
                        user.set(routines).then().catch();
                        return 200;
                    }
                    else {
                        for (let i = 0; i < routines['goals&routines'].length; i++) {
                            if (routines['goals&routines'][i].id === routineId) {
                                routines['goals&routines'][i].is_in_progress = false;
                                routines['goals&routines'][i].is_complete = true;
                                routines['goals&routines'][i].datetime_completed = getCurrentDateTimeUTC();
                                user.set(routines).then().catch();
                                console.log('Success');
                                return 200;
                            }
                        }
                        return 404;
                    }
                }
            })
            .catch(err => {
            console.log('Error getting document', err);
            return 400;
        });
    }
    else{
      return 400;
    }
});


exports.CompleteActionOrTask = functions.https.onCall( async (data, context) => {

    //Grab the text parameter.
    const userId = data.userId?.toString();
    const routineId = data.routineId?.toString();
    const taskId = data.taskId?.toString();
    const taskNumberReq = data.taskNumber?.toString();
    let taskNumber;

    if (userId && routineId && taskId && taskNumberReq) {
        const routine = db.collection('users').doc(userId).collection('goals&routines').doc(routineId);

        //Using a promise here since 'onCall' is async.
        return routine.get()
            .then(doc => {
                if (!doc.exists) {
                    console.log('No such document!');
                    return 404;
                }
                else {
                    taskNumber = parseInt(taskNumberReq);
                    const tasks = doc.data()!;
                    if (tasks['actions&tasks'].length>taskNumber && tasks['actions&tasks'][taskNumber].id === taskId) {
                        tasks['actions&tasks'][taskNumber].is_in_progress = false;
                        tasks['actions&tasks'][taskNumber].is_complete = true;
                        tasks['actions&tasks'][taskNumber].datetime_completed = getCurrentDateTimeUTC();
                        routine.set(tasks).then().catch();
                        console.log('Success');
                        return 200;
                    }
                    else {
                        console.log('Will iterate now...');
                        for (let i = 0; i < tasks['actions&tasks'].length; i++) {
                            if (tasks['actions&tasks'][i].id === taskId) {
                                tasks['actions&tasks'][i].is_in_progress = false;
                                tasks['actions&tasks'][i].is_complete = true;
                                tasks['actions&tasks'][i].datetime_completed = getCurrentDateTimeUTC();
                                routine.set(tasks).then().catch();
                                console.log('Success');
                                return 200;
                            }
                        }
                        return 404;
                    }
                }
            })
            .catch(err => {
            console.log('Error getting document', err);
            return 400;
        });
    }
    else{
      return 400;
    }
});

exports.CompleteInstructionOrStep = functions.https.onCall(async (data, context) => {

    //Grab the text parameter.
    const userId = data.userId?.toString();
    const routineId = data.routineId?.toString();
    const taskId = data.taskId?.toString();
    const stepNumberReq = data.stepNumber?.toString();
    let stepNumber;

    if (userId && routineId && taskId && stepNumberReq) {
        console.log('First test passed...');
        const task = db.collection('users').doc(userId).collection('goals&routines').doc(routineId).collection('actions&tasks').doc(taskId);

        //Using a promise here since 'onCall' is async.
        return task.get()
            .then(doc => {
                if (!doc.exists) {
                    console.log('No such document!');
                    return 404;
                }
                else {
                    stepNumber = parseInt(stepNumberReq);
                    const steps = doc.data()!;
                    steps['instructions&steps'][stepNumber].is_in_progress = false;
                    steps['instructions&steps'][stepNumber].is_complete = true;
                    steps['instructions&steps'][stepNumber].datetime_completed = getCurrentDateTimeUTC();
                    task.set(steps).then().catch();
                    console.log('Success');
                    return 200;
                }
            })
            .catch(err => {
            console.log('Error getting document', err);
            return 400;
        });
    }
    else{
      return 400;
    }
});

function getCurrentDateTimeUTC() {
    const today = new Date()
    return today.toUTCString()
}

export const GetEventsForTheDay = functions.https.onRequest((req, res) => {

    const id = req.body.id.toString();
    const startParam = req.body.start.toString();
    const endParam = req.body.end.toString();

    console.log( 'start : ', startParam, ' end:', endParam );

    setUpAuthById( id, ( auth: any ) => {
        if(auth===500) {
            res.status(500).send('Failed to find document!');
        }
        else {
            const calendar = google.calendar( { version: 'v3', auth } );
            calendar.events.list(
                {
                    calendarId:   'primary',
                    timeMin:      startParam,
                    timeMax:      endParam,
                    maxResults:   999,
                    singleEvents: true,
                    orderBy:      'startTime'
                    //timeZone: 
                },
                (error: any, response: any) => {
                    //CallBack
                    if ( error ) {
                        res.status(500).send( 'The post request returned an error: ' + error );
                    }
                    else{
                        res.status(200).send(response.data.items);
                    }
                }
            );
        }
    });
});
  
function setUpAuthById( id: string, callback: any ) {
    console.log("SETUPAUTHBYID");
    fs.readFile( credentials_url, ( err: any, content: any ) => {
        if ( err ) {
            console.log( 'Error loading client secret file:', err );
            return;
        }
        // Authorize a client with credentials, then call the Google Calendar
        authorizeById( JSON.parse( content ), id, callback ); 
    });
  }

function authorizeById( credentials: any, id: string, callback: any ) {
    console.log("AUTHORIZEBYID");
    const { client_secret, client_id } = credentials.web;
  
    const oAuth2Client = new OAuth2Client(
        client_id,
        client_secret,
        redirect_uri
    );

    // Store to firebase
	if ( id ) {
        db.collection( 'users' ).doc( id ).get()
        .then((doc) => {
            if (!doc.exists) {
                console.log('No such document!');
                callback(500);
            }
            else {
                const userAuthInfo = doc.data();
                oAuth2Client.setCredentials( {
                access_token:  userAuthInfo!.google_auth_token,
                refresh_token: userAuthInfo!.google_refresh_token
            });
            callback(oAuth2Client);
            }
        })
        .catch(error=>{
            console.log("Error::: ", error);
        });
	}
}


export const ModifyFirestoreTime = functions.https.onRequest((req, res) => {
    db.collection('users').get()
    .then((snapshot) => {
        snapshot.forEach(doc => {
            if (doc.data()["goals&routines"] !== undefined) {
                let arrs = doc.data()["goals&routines"];
                arrs.forEach(async (gr: {
                    id: string,
                    start_day_and_time: string,
                    end_day_and_time: string
                }) => { 
                    const startDate = new Date(gr["start_day_and_time"]).toLocaleString('en-US', {
                        timeZone: "America/Los_Angeles"
                    });
                    const endDate = new Date(gr["end_day_and_time"]).toLocaleString('en-US', {
                        timeZone: "America/Los_Angeles"
                    });
                    gr["start_day_and_time"] = startDate;
                    gr["end_day_and_time"] = endDate;
                    
                    await db.collection("users").doc(doc.id)
                    .update({ "goals&routines": arrs })
                    .then(() => {
                        console.log('Update succesful', doc.id);
                    })
                    .catch(() => {
                        console.log('error in', doc.id);
                    });
                });
                console.log(doc.id);
            }
        });
        res.status(200).send('All good');
    })
    .catch(error=>{
        console.log('Error ',error)
        res.status(500).send('Error.')
    });
});

export const ActionTaskLogger = functions
    .firestore
    .document('users/{userId}/goals&routines/{goalId}')
    .onUpdate( async (change, context) => {
        const userId = context.params.userId.toString();
        const goalId = context.params.goalId.toString();
        const newVal = change.after.data();
        const prevVal = change.before.data();

        console.log('User ID: ', userId);

        let i;

        if(newVal['actions&tasks'].length !== prevVal['actions&tasks'].length){
            console.log('Added a new action/task to goal: ', goalId);        
        }

        for(i=0; i<newVal['actions&tasks'].length; i++){
            if(JSON.stringify(newVal['actions&tasks'][i]) !== JSON.stringify(prevVal['actions&tasks'][i])){
                console.log('Change in action/task: ', prevVal['actions&tasks'][i].title);
            }
        }
    });