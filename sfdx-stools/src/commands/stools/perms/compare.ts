import { flags, SfdxCommand } from '@salesforce/command';
import { Messages, SfdxError } from '@salesforce/core';
import { AnyJson } from '@salesforce/ts-types';

var fs = require('fs');
var xml2json = require("xml2js").parseString;
var xml2js = require("xml2js");

// Initialize Messages with the current plugin directory
Messages.importMessagesDirectory(__dirname);

// Load the specific messages for this file. Messages from @salesforce/command, @salesforce/core,
// or any library that is using the messages framework can also be loaded this way.
const messages = Messages.loadMessages('sfdx-stools', 'compare');

enum mergeAction {
    add,
    update,
    new,
    remove,
    convert
};

enum exitCode {
    match = 0,
    error = 1,
    nomatch = 3
};

/*
* COMPARE COMMAND CLASS 
*/
export default class Compare extends SfdxCommand {

    public static description = messages.getMessage('commandDescription');

    public static examples = [
    `$ sfdx comparinator:perms:compare -s permset1.xml,permset2.xml -t permset3.xml,permset4.xml -f differences.xml
    `,
    `$ sfdx comparinator:perms:compare -s permset1 -t permset2,permset3 -g
    `
    ];

    public static args = [{name: 'file'}];

    protected static flagsConfig = {
        // flag with a value (-n, --name=VALUE)
        sourceperms: flags.array({char: 's', required: true, description: messages.getMessage('permsetsourceFlagDescription')}),
        targetperms: flags.array({char: 't', required: true, description: messages.getMessage('permsettargetFlagDescription')}),
        getorg: flags.boolean({char: 'g', description: messages.getMessage('getorgFlagDescription')}),
        getpermsdir: flags.boolean({char: 'd', description: messages.getMessage('getpermsdirFlagDescription')}),
        tofile: flags.string({char: 'f', description: messages.getMessage('tofileFlagDescription')})
    };

    protected static supportsUsername = true;
    protected static requiresProject = false;

    // Permission types currently supported by merge command
    private permKey = { 
        customPermissions : { nameKey : "name", enabledKey : "enabled", enabledValue : "true", label : "Custom Permissions" },
        classAccesses : { nameKey : "apexClass", enabledKey : "enabled", enabledValue : "true", label : "Apex Classes"  },
        userPermissions : { nameKey : "name", enabledKey : "enabled", enabledValue : "true", label : "User Permissions"  },
        recordTypeVisibilities : { nameKey : "recordType", enabledKey : "visible", enabledValue : "true", label : "Record Types"  },
        tabSettings : { nameKey : "tab", enabledKey : "visibility", enabledValue : "Visible", label : "Tab Settings"  },
        objectPermissions : { nameKey : "object", enabledKeys : ["allowCreate", "allowDelete", "allowEdit", "allowRead", "modifyAllRecords", "viewAllRecords"], enabledValue : "true", label : "Objects" },
        fieldPermissions : { nameKey : "field", enabledKeys : ["editable", "readable"], enabledValue : "true", label : "Fields" }
    };  

    // Permission types currently supported by compare command
    private permTypesSupportedCompare = [
        'customPermissions',
        'classAccesses',
        'userPermissions',
        'objectPermissions',
        'fieldPermissions'
    ];  

    /*
    *  COMMAND STARTS HERE
    */

    public async run(): Promise<AnyJson> {
        
        let retval = exitCode.match; // success by default

        const sourcepermsList = this.flags.sourceperms;
        const targetpermsList = this.flags.targetperms;
        const xmlfile = this.flags.tofile;


        // Merge both source and target permission lists

        let sourcePerms = this.doMerge(sourcepermsList);
        let targetPerms = this.doMerge(targetpermsList);

        this.ux.log("-------------------\nCOMPARINATOR REPORT\n-------------------");
        let higherPerms = this.doCompare(sourcePerms, targetPerms);
        
        if (this.isMatch(higherPerms)) {
            this.ux.log("\n\x1b[32m%s\x1b[0m", "**** OK: permissions match ****\n");

        } else { // No Match
            retval = exitCode.nomatch;  
            this.ux.log("\n\x1b[31m%s\x1b[0m", '**** WARNING: target side has higher permissions than source ****\n');

            // If --json then write higher permissions as Json
            if (this.flags.json) {
                console.log(JSON.stringify(higherPerms, null, 2));
                // console.dir(JSON.stringify(higherPerms, { depth : null }));
            }
        }

        if (this.flags.tofile) {
            this.writePermsToXmlFile(xmlfile, higherPerms);
        }

        // Exit - return 3 if target bestows higher permissions, otherwise 0
        process.exit(retval);
    }

    /*
    *   Compares json representations of permissions source vs target
    *   Finds where target has higher permissions than source
    *   Returns json structure of perms
    *   where target has higher perms than source
    */
    private doCompare (json1, json2) {
        interface LooseObject {
            [key: string]: any
        }
        
        var higherPerms: LooseObject = {};
        higherPerms.PermissionSet = {};

        var hasHigherPerms = false;

        // check for permission types common between the two perm files
        for (let permType in json2.PermissionSet) {
            if (this.isSupportedPermType(permType)) {
                let tainted = false;
                this.ux.log("\x1b[0m" + this.permKey[permType].label);
                if (this.isPermIn (json1, permType)) {
                    // Both json1 and json2 have this permission type
                    // Lets look deeper
                    if (permType in this.permKey ) {
                        // Loop through json2 permissions for this permission type
                        for(let i = 0; i < json2.PermissionSet[permType].length; i++) {  
                            var entityIndex = this.permEntityIndex (json1.PermissionSet[permType], this.permKey[permType].nameKey, json2.PermissionSet[permType][i][this.permKey[permType].nameKey]);
                             if (entityIndex < 0) {
                                /// If the perm entity is in json2 but not json1, then add it verbatim to result
                                tainted = true;
                                hasHigherPerms = true;
                                this.ux.log("\x1b[31m%s\x1b[0m", "  + " + json2.PermissionSet[permType][i][this.permKey[permType].nameKey]);
                                if (higherPerms.PermissionSet[permType] === undefined) higherPerms.PermissionSet[permType] = [];
                                higherPerms.PermissionSet[permType].push(json2.PermissionSet[permType][i]);
                            } else {
                                // Same permission entity exists in both json1 and json 2
                                // for simple true/false types like custom permisisons or Apex classes this means they are equivalent, so no further action
                                // However for more complex types, i.e. more than one perm setting per entity, like an object
                                // then we need to go deeper and compare each permission setting json2 -> json1 : true beats false!
                                if (permType === 'objectPermissions' || permType === 'fieldPermissions') {
                                    if (higherPerms.PermissionSet[permType] === undefined) higherPerms.PermissionSet[permType] = []; // first instance of this permission type, create a new array
                                    higherPerms.PermissionSet[permType].push(json2.PermissionSet[permType][i]); // assume this permission entity has higher permissions, add it to result array
                                    let hasHigherAccess = false;
                                    for (let j = 0; j < this.permKey[permType].enabledKeys.length; j++) {  
                                        let oKey = this.permKey[permType].nameKey;
                                        let eKey = this.permKey[permType].enabledKeys[j];
                                        let eValue = this.permKey[permType].enabledValue;
                                        let objName = json2.PermissionSet[permType][i][oKey];
                                        let v1 = json1.PermissionSet[permType][entityIndex][eKey];
                                        let v2 = json2.PermissionSet[permType][i][eKey];
                                        if (v2[0] === eValue  && !(v1[0] === eValue)) {
                                            // json2 has higher permission for this setting, leave it in the diffs result
                                            tainted = true;
                                            hasHigherPerms = true;
                                            if (!hasHigherAccess) this.ux.log("\x1b[31m%s\x1b[0m", "  + " + objName);
                                            this.ux.log ("\x1b[31m%s\x1b[0m", "    + " + eKey + " = " + eValue);
                                            hasHigherAccess = true;
                                        }
                                        else {
                                            // json2 does NOT have higher level of access, remove this permission entity setting from result
                                            delete higherPerms.PermissionSet[permType][higherPerms.PermissionSet[permType].length-1][eKey];    
                                        }
                                    }
                                    if (!hasHigherAccess) higherPerms.PermissionSet[permType].splice(higherPerms.PermissionSet[permType].length-1,1); // remove permission entity we added ealier, false alarm
                                }
                            }
                        }
                    }

                } else {
                    // Add entire json2 permtype node to json1
                    tainted = true;
                    hasHigherPerms = true;
                    this.ux.log("\x1b[31m%s\x1b[0m", "  + grants access to this permission type");
                    higherPerms.PermissionSet[permType] = json2.PermissionSet[permType];
                }
                if (!tainted) this.ux.log("\x1b[32m%s\x1b[0m", "  match");
            }
        }
        if (!hasHigherPerms) higherPerms = null;
        return higherPerms;
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

    private isSupportedPermType(permType) {
        for (let i = 0; i < this.permTypesSupportedCompare.length; i++) {
            if (this.permTypesSupportedCompare[i].toString() === permType.toString()) {
                return true;
            }
        }
        return false;
    }

    private isMatch(difs) {
        
        if (difs === null) {
            return true;
        } else {
            return false;
        }
    }

    private writePermsToXmlFile (file, perms) {
        if (perms === null) perms={ PermissionSet: {} };
        var builder = new xml2js.Builder();
        var xml = builder.buildObject(perms);
        // Write a string to another file and set the file mode to 0755
        try {
            fs.writeFileSync(file, xml);
        } catch(err) {
            if (err) throw new SfdxError(messages.getMessage('errorWritingXmlFile', [err]), 'File Error', undefined, exitCode.error);
        }
    }
}