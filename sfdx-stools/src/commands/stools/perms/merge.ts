import { flags, SfdxCommand } from '@salesforce/command';
import { Messages, SfdxError } from '@salesforce/core';
import { AnyJson } from '@salesforce/ts-types';

var fs = require('fs');
var xml2json = require("xml2js").parseString;
var xml2js = require("xml2js");

// Initialize and load messages 
Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages('sfdx-stools', 'merge');

// Log file is at USER_HOME_DIR/.sfdx/sfdx.log

enum mergeAction {
    add,
    update,
    new,
    remove,
    convert
}

enum exitCode {
    ok = 0,
    error = 1
};


/*
* MERGE COMMAND CLASS 
*/

export default class Merge extends SfdxCommand {

    public static description = messages.getMessage('commandDescription');

    public static examples = [
    `$ sfdx comparinator:perms:merge -p permset1.xml,permset2.xml,permset3.xml
    `,
    `$ sfdx comparinator:perms:merge -p permset1,permset2,permset3 -g
    `
    ];

    public static args = [{name: 'file'}];

    protected static flagsConfig = {
        permissionsets: flags.array({char: 'p', required: true, description: messages.getMessage('permsetFlagDescription')}),
        formatasprofile: flags.boolean({char: 'l', description: messages.getMessage('formatasprofileFlagDescription')}),
        getorg: flags.boolean({char: 'g', description: messages.getMessage('getorgFlagDescription')}),
        getpermsdir: flags.boolean({char: 'd', description: messages.getMessage('getpermsdirFlagDescription')})
    };

    protected static supportsUsername = true;
    protected static requiresProject = false;

    // Permission types currently supported by merge command
    private permKey = { 
        customPermissions : { nameKey : "name", enabledKey : "enabled", enabledValue : "true" },
        classAccesses : { nameKey : "apexClass", enabledKey : "enabled", enabledValue : "true" },
        userPermissions : { nameKey : "name", enabledKey : "enabled", enabledValue : "true" },
        recordTypeVisibilities : { nameKey : "recordType", enabledKey : "visible", enabledValue : "true" },
        tabSettings : { nameKey : "tab", enabledKey : "visibility", enabledValue : "Visible" },
        objectPermissions : { nameKey : "object", enabledKeys : ["allowCreate", "allowDelete", "allowEdit", "allowRead", "modifyAllRecords", "viewAllRecords"], enabledValue : "true"},
        fieldPermissions : { nameKey : "field", enabledKeys : ["editable", "readable"], enabledValue : "true"}
    };  

    public async run(): Promise<AnyJson> {
        
        let retval = exitCode.ok; // success by default

        const permsetList = this.flags.permissionsets;

        // Do the merge
        let mergedPermissions = this.doMerge(permsetList);

        // Format the output as either a Profile or a Permission Set
        let formatAsProfile = this.flags.formatasprofile ? true : false;
        mergedPermissions = this.formatPermissionsFile(mergedPermissions, formatAsProfile);

        // If --json flag write merged perm file to stdout as json, otherwise as xml
        if (this.flags.json) {
            console.dir(mergedPermissions, { depth: null });
        } else {
            var builder = new xml2js.Builder();
            var xml = builder.buildObject(mergedPermissions);
            this.ux.log(xml);
        }
        
        process.exit(retval);
        // return { mergedPermissions };
    }

    /*
    *   Merges XML permissions into single permission 
    *   Input is an array of permission set file names to merge
    *   Returns json version of the merged permissions
    */
    private doMerge (mergeFilesArray) {

        var json1, json2;       // json versions of xml
        
        // Convert first XML file in list to Json1
        json1 = this.xmlPermFile2Json(mergeFilesArray[0]);

        // Now loop around merging subsequent files with json1
        // Essentially accumlating higher permissions n json1 as we go
        for (let i = 1 ; i < mergeFilesArray.length ; i++) {
            json2 = this.xmlPermFile2Json(mergeFilesArray[i]);
            // check for permission types common between the two perm files
            for (let permType in json2.PermissionSet) {
                if (this.isPermIn (json1, permType)) {
                    // Both json1 and json2 have this permission type
                    if (permType in this.permKey) {
                        // Loop through json2 permissions for this permission type
                        for(let i = 0; i < json2.PermissionSet[permType].length; i++) {   
                            let eName = json2.PermissionSet[permType][i][this.permKey[permType].nameKey];                           
                            var entityIndex = this.permEntityIndex (json1.PermissionSet[permType], this.permKey[permType].nameKey, eName);
                            if (entityIndex < 0) {
                                // Perm entity e.g. Object__c is in json2 but not json1, so add its permissions verbatim to json1
                                json1.PermissionSet[permType].push(json2.PermissionSet[permType][i]);
                                this.logMergeAction(mergeAction.add, permType, eName.toString(), null, null);
                            } else {
                                // merge permissions json2 -> json1 : true beats false!
                                if (permType === 'objectPermissions' || permType === 'fieldPermissions') {
                                    for (let j = 0; j < this.permKey[permType].enabledKeys.length; j++) {  
                                        let oKey = this.permKey[permType].nameKey;
                                        let eKey = this.permKey[permType].enabledKeys[j];
                                        let eValue = this.permKey[permType].enabledValue;
                                        let eName = json2.PermissionSet[permType][i][oKey];
                                        let v1 = json1.PermissionSet[permType][entityIndex][eKey];
                                        let v2 = json2.PermissionSet[permType][i][eKey];
                                        if (v2[0] === eValue  && !(v1[0] === eValue)) {
                                            json1.PermissionSet[permType][entityIndex][eKey][0] = eValue;
                                            this.logMergeAction(mergeAction.update, permType, eName.toString(), eKey, eValue);
                                        }
                                    }
                                }
                            }
                        }
                    }

                } else {
                    // Add entire json2 permtype node to json1
                    json1.PermissionSet[permType] = json2.PermissionSet[permType];
                    this.logMergeAction(mergeAction.new, permType, null, null, null);
                }
            }
        }
        return json1;
    }

    private xmlPermFile2Json(xmlFile: any) {
        if (!fs.existsSync(xmlFile)) {
            this.fileNotFound(xmlFile);
        }
        var xml = fs.readFileSync(xmlFile, "utf-8");
        var json = this.xml2jsonSync(xml);
        // convert Profiles  to Permission Sets
        if('Profile' in json){
            json.PermissionSet = json.Profile;
            delete json.Profile;
            this.logMergeAction(mergeAction.convert, null, null, null, null);
        }
        return json;
    }

    private fileNotFound(xmlFile1: any) {
        throw new SfdxError(messages.getMessage('errorFileDoesNotExist', [xmlFile1]), 'File Error', undefined, exitCode.error);
    }

    // Writes message to sfdx common log file
    private logMergeAction (action: mergeAction, type:string, entity:string, setting:string, value:string) {      
        var message;
        switch (action) {
            case mergeAction.add:
                message = messages.getMessage('logMergeActionAdd', [type, entity]);
                break;
            case mergeAction.update:
                message = messages.getMessage('logMergeActionUpdate', [type, entity, setting, value]);
                break;
            case mergeAction.new:
                message = messages.getMessage('logMergeActionNew', [type]);
                break;
            case mergeAction.remove:
                message = messages.getMessage('logMergeActionRemove', [type]);
                break;
            case mergeAction.convert:
                message = messages.getMessage('logMergeActionConvert');
                break;
            default:
                return;
        }
        this.logger.info(message);
    }

    private isPermIn (json, key) {
        for (let tkey in json.PermissionSet) {
            if (key === tkey) {
                return true;
            }
        } 
        return false;   
    }

    private permEntityIndex (jsonArray, permKey, valueToMatch) {
        for(let i = 0; i < jsonArray.length; i++) {  
            if (jsonArray[i][permKey].toString() == valueToMatch.toString()) {
                return i;
            }
        }
        return -1;
    }

    private xml2jsonSync (xml) {

        var error = null;
        var json = null;
        xml2json(xml, function (innerError, innerJson) {

            error = innerError;
            json = innerJson;
        });

        if (error) throw new SfdxError('Couldnt convert xml to json', 'Conversion Error', undefined, exitCode.error );
        if (!error && !json) throw new SfdxError('Couldnt convert xml to json', 'Conversion Error', undefined, exitCode.error );
        
        return json;
    }

    private formatPermissionsFile(json, makeProfile) {
        
        // Permission types to remove when formatting as permission set
        let permTypesToRemovePermissionSet = [
            'categoryGroupVisibilities',
            'custom',
            'fullName',
            'layoutAssignments',
            'loginHours',
            'loginIpRanges',
            'profileActionOverrides'];  

            // Permission types to remove when formatting as profile
        let permTypesToRemoveProfile = [
            'license',
            'hasActivationRequired',
            'label',
            'layout'];  

        
        if (makeProfile) {
            console.log('converting to Profile format');
            // convert top line property to Profile
            if('PermissionSet' in json){
                json.Profile = json.PermissionSet;
                delete json.PermissionSet;
            }
            if ('description' in json.Profile) json.Profile.description = ["Profile generated by The Comparinator " + new Date().toISOString()]; 
            if ('custom' in json.Profile) json.Profile.custom = ["true"];

        } else {
            // convert top line property to Permission Set
            if('Profile' in json){
                console.log('converting top prop to Perm Set'); 
                json.PermissionSet = json.Profile;
                delete json.Profile;
            }
            if ('description' in json.PermissionSet) json.PermissionSet.description = ["Permission Set generated by The Comparinator " + new Date().toISOString()]; 
        }

        let permTypesToRemove = makeProfile ? permTypesToRemoveProfile : permTypesToRemovePermissionSet;
        let format = makeProfile ? "Profile" : "PermissionSet";
        // remove permission types not supported in this format
        for (let j = 0; j < permTypesToRemove.length; j++) { 
            if (permTypesToRemove[j] in json[format]) {
                this.logMergeAction(mergeAction.remove, permTypesToRemove[j], null, null, null);    
                delete json[format][permTypesToRemove[j]];
            }
        }
       
        return json;
    }
}