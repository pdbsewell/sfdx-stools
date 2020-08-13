import { flags, SfdxCommand } from '@salesforce/command';
import { Messages, SfdxError } from '@salesforce/core';
import { AnyJson } from '@salesforce/ts-types';

var fs = require('fs');
var xml2js = require("xml2js");
var { execSync }  = require('child_process');

// Initialize and load messages 
Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages('sfdx-stools', 'make');

enum exitCode {
    ok = 0,
    error = 1
};

/*
* MAKE COMMAND CLASS 
*/

export default class Make extends SfdxCommand {

    public static description = messages.getMessage('commandDescription');

    public static examples = [
    `$ sfdx comparinator:perms:make -o 
    `,
    `$ sfdx comparinator:perms:make -o --json
    `
    ];

    public static args = [{name: 'file'}];

    protected static flagsConfig = {
        makeobjects: flags.boolean({char: 'o', required: true, description: messages.getMessage('makeobjectsFlagDescription')})
    };

    protected static supportsUsername = true;
    protected static requiresProject = false;

    public async run(): Promise<AnyJson> {
        
        let retval = exitCode.ok; // success by default

        let permissionsSet = {
            "PermissionSet": {
                "objectPermissions": []
            }
        };
        var resultFile = 'objectList.json'
        var objectList;
        execSync('sfdx force:schema:sobject:list -c custom --json 1>' + resultFile);

        if (!fs.existsSync(resultFile)) {
            this.fileNotFound(resultFile);
        } else {
            let resultJson = JSON.parse(fs.readFileSync(resultFile, "utf-8"));
            objectList = resultJson.result;
            // console.dir(objectList, {depth:null});
        }
        for (let i = 0; i < objectList.length ; i++){
            let objectEntity = { 
                'allowCreate': [ 'false' ],
                'allowDelete': [ 'false' ],
                'allowEdit': [ 'false' ],
                'allowRead': [ 'true' ],
                'modifyAllRecords': [ 'false' ],
                'object': [ objectList[i] ],
                'viewAllRecords': [ 'false' ]};
                // console.dir(objectEntity);
            permissionsSet.PermissionSet.objectPermissions.push(objectEntity);
        }

        // If --json flag write merged perms to stdout as json, otherwise as xml
        if (this.flags.json) {
            console.dir(permissionsSet, {depth:null});
        } else {
            var builder = new xml2js.Builder();
            var xml = builder.buildObject(permissionsSet);
            this.ux.log(xml);
        }
        
        process.exit(retval);
        // return { mergedPermissions };
    }

    private fileNotFound(xmlFile1: any) {
        throw new SfdxError(messages.getMessage('errorFileDoesNotExist', [xmlFile1]), 'File Error', undefined, exitCode.error);
    }
}