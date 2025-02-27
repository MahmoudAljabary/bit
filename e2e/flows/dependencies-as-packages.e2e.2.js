import path from 'path';
import fs from 'fs-extra';
import chai, { expect } from 'chai';
import Helper from '../../src/e2e-helper/e2e-helper';
import * as fixtures from '../fixtures/fixtures';
import NpmCiRegistry, { supportNpmCiRegistryTesting } from '../npm-ci-registry';
import { statusWorkspaceIsCleanMsg } from '../../src/cli/commands/public-cmds/status-cmd';
import { componentIssuesLabels } from '../../src/cli/templates/component-issues-template';

chai.use(require('chai-fs'));

(supportNpmCiRegistryTesting ? describe : describe.skip)(
  'installing dependencies as packages (not as components)',
  function () {
    this.timeout(0);
    let helper = new Helper();
    let npmCiRegistry;
    after(() => {
      helper.scopeHelper.destroy();
    });
    describe('components with nested dependencies', () => {
      before(async () => {
        npmCiRegistry = new NpmCiRegistry(helper);
        await npmCiRegistry.init();
        helper.scopeHelper.setNewLocalAndRemoteScopes();
        npmCiRegistry.setCiScopeInBitJson();
        helper.fs.createFile('utils', 'is-type.js', fixtures.isType);
        helper.fixtures.addComponentUtilsIsType();
        helper.fs.createFile('utils', 'is-string.js', fixtures.isString);
        helper.fixtures.addComponentUtilsIsString();
        helper.fixtures.createComponentBarFoo(fixtures.barFooFixture);
        // creating a dev dependency for bar/foo to make sure the links are not generated. (see bug #1614)
        helper.fs.createFile('fixtures', 'mock.json');
        helper.command.addComponent('fixtures');
        helper.fs.createFile('bar', 'foo.spec.js', "require('../fixtures/mock.json');");
        helper.command.addComponent('bar/foo.js', { t: 'bar/foo.spec.js', i: 'bar/foo' });
        helper.command.tagAllComponents();
        helper.command.tagAllComponents('-s 0.0.2');
        helper.command.exportAllComponents();
        helper.scopeHelper.reInitLocalScope();
        npmCiRegistry.setCiScopeInBitJson();
        helper.scopeHelper.addRemoteScope();
        helper.command.importComponent('bar/foo');
        helper.command.importComponent('utils/is-type');
        helper.command.importComponent('utils/is-string');
        helper.command.importComponent('fixtures');

        helper.extensions.importNpmPackExtension();
        helper.scopeHelper.removeRemoteScope();
        npmCiRegistry.publishComponent('utils/is-type');
        npmCiRegistry.publishComponent('utils/is-string');
        npmCiRegistry.publishComponent('bar/foo');
        npmCiRegistry.publishComponent('fixtures');
        npmCiRegistry.publishComponent('utils/is-type', '0.0.2');
        npmCiRegistry.publishComponent('utils/is-string', '0.0.2');
        npmCiRegistry.publishComponent('bar/foo', '0.0.2');
        npmCiRegistry.publishComponent('fixtures', '0.0.2');
      });
      after(() => {
        npmCiRegistry.destroy();
      });
      describe('installing a component using NPM', () => {
        before(() => {
          helper.scopeHelper.reInitLocalScope();
          helper.command.runCmd('npm init -y');
          helper.command.runCmd(`npm install @ci/${helper.scopes.remote}.bar.foo`);
        });
        it('should be able to require its direct dependency and print results from all dependencies', () => {
          const appJsFixture = `const barFoo = require('@ci/${helper.scopes.remote}.bar.foo'); console.log(barFoo());`;
          fs.outputFileSync(path.join(helper.scopes.localPath, 'app.js'), appJsFixture);
          const result = helper.command.runCmd('node app.js');
          expect(result.trim()).to.equal('got is-type and got is-string and got foo');
        });
      });
      describe('importing a component using Bit', () => {
        let beforeImportScope;
        let afterImportScope;
        before(() => {
          helper.scopeHelper.reInitLocalScope();
          npmCiRegistry.setCiScopeInBitJson();
          npmCiRegistry.setResolver();
          beforeImportScope = helper.scopeHelper.cloneLocalScope();
          helper.command.importComponent('bar/foo');
          afterImportScope = helper.scopeHelper.cloneLocalScope();
        });
        it('should not create .dependencies directory', () => {
          expect(path.join(helper.scopes.localPath, 'components/.dependencies')).to.not.be.a.path();
        });
        it('should install the dependencies using NPM', () => {
          const basePath = path.join(helper.scopes.localPath, 'components/bar/foo/node_modules/@ci');
          expect(path.join(basePath, `${helper.scopes.remote}.utils.is-string`, 'is-string.js')).to.be.a.file();
          expect(path.join(basePath, `${helper.scopes.remote}.utils.is-type`, 'is-type.js')).to.be.a.file();
        });
        it('bit status should not show any error', () => {
          const output = helper.command.runCmd('bit status');
          expect(output).to.have.a.string(statusWorkspaceIsCleanMsg);
        });
        it('should be able to require its direct dependency and print results from all dependencies', () => {
          const appJsFixture = "const barFoo = require('./components/bar/foo'); console.log(barFoo());";
          fs.outputFileSync(path.join(helper.scopes.localPath, 'app.js'), appJsFixture);
          const result = helper.command.runCmd('node app.js');
          expect(result.trim()).to.equal('got is-type and got is-string and got foo');
        });
        describe('checkout to an older version', () => {
          before(() => {
            helper.command.checkout('0.0.1 bar/foo');
          });
          it('should not create .dependencies directory', () => {
            expect(path.join(helper.scopes.localPath, 'components/.dependencies')).to.not.be.a.path();
          });
          it('should install the dependencies using NPM', () => {
            const basePath = path.join(helper.scopes.localPath, 'components/bar/foo/node_modules/@ci');
            expect(path.join(basePath, `${helper.scopes.remote}.utils.is-string`, 'is-string.js')).to.be.a.file();
            expect(path.join(basePath, `${helper.scopes.remote}.utils.is-type`, 'is-type.js')).to.be.a.file();
          });
          it('bit status should not show any error', () => {
            const output = helper.command.runCmd('bit status');
            expect(output).to.have.a.string('pending updates');
          });
          it('should be able to require its direct dependency and print results from all dependencies', () => {
            const appJsFixture = "const barFoo = require('./components/bar/foo'); console.log(barFoo());";
            fs.outputFileSync(path.join(helper.scopes.localPath, 'app.js'), appJsFixture);
            const result = helper.command.runCmd('node app.js');
            expect(result.trim()).to.equal('got is-type and got is-string and got foo');
          });
        });
        describe('import all dependencies directly', () => {
          before(() => {
            helper.scopeHelper.getClonedLocalScope(afterImportScope);
            helper.command.importComponent('utils/is-string');
            helper.command.importComponent('utils/is-type');
          });
          it('should write the correct scope in the package.json file', () => {
            const packageJson = helper.packageJson.read();
            const packages = Object.keys(packageJson.dependencies);
            expect(packages).to.include(`@ci/${helper.scopes.remote}.bar.foo`);
            expect(packages).to.include(`@ci/${helper.scopes.remote}.utils.is-string`);
            expect(packages).to.include(`@ci/${helper.scopes.remote}.utils.is-type`);
          });
          it('bit status should not show any error', () => {
            const output = helper.command.runCmd('bit status');
            expect(output).to.have.a.string(statusWorkspaceIsCleanMsg);
          });
          describe('bit checkout all components to an older version', () => {
            let checkoutOutput;
            before(() => {
              checkoutOutput = helper.command.checkout('0.0.1 --all');
            });
            it('should not crash and show a success message', () => {
              expect(checkoutOutput).to.have.string('successfully switched');
            });
            it('should be able to require its direct dependency and print results from all dependencies', () => {
              const appJsFixture = "const barFoo = require('./components/bar/foo'); console.log(barFoo());";
              fs.outputFileSync(path.join(helper.scopes.localPath, 'app.js'), appJsFixture);
              const result = helper.command.runCmd('node app.js');
              expect(result.trim()).to.equal('got is-type and got is-string and got foo');
            });
          });
        });
        describe('updating dependency version from the dependent package.json', () => {
          describe('when using caret (^) in the version', () => {
            before(() => {
              helper.scopeHelper.getClonedLocalScope(afterImportScope);
              const barFooDir = path.join(helper.scopes.localPath, 'components/bar/foo');
              const packageJson = helper.packageJson.read(barFooDir);
              packageJson.dependencies[`@ci/${helper.scopes.remote}.utils.is-string`] = '^1.0.0';
              helper.packageJson.write(packageJson, barFooDir);
            });
            it('should show the dependency version from the package.json', () => {
              const barFoo = helper.command.showComponentParsed('bar/foo');
              expect(barFoo.dependencies[0].id).to.equal(`${helper.scopes.remote}/utils/is-string@1.0.0`);
            });
          });
          describe('when importing also the dependency so the package.json has a different version than the model', () => {
            before(() => {
              helper.scopeHelper.getClonedLocalScope(beforeImportScope);
              helper.command.importComponent('bar/foo');
              helper.command.importComponent('utils/is-string');
              const barFooDir = path.join(helper.scopes.localPath, 'components/bar/foo');
              const packageJson = helper.packageJson.read(barFooDir);
              packageJson.dependencies[`@ci/${helper.scopes.remote}.utils.is-string`] = '0.0.1';
              helper.packageJson.write(packageJson, barFooDir);
            });
            it('should show the dependency version from the package.json', () => {
              const barFoo = helper.command.showComponentParsed('bar/foo');
              expect(barFoo.dependencies[0].id).to.equal(`${helper.scopes.remote}/utils/is-string@0.0.1`);
            });
            it('bit diff should show the dependencies ', () => {
              const diff = helper.command.diff('bar/foo');
              expect(diff).to.have.string(`- [ ${helper.scopes.remote}/utils/is-string@0.0.2 ]`);
              expect(diff).to.have.string(`+ [ ${helper.scopes.remote}/utils/is-string@0.0.1 ]`);
            });
            describe('tagging the component', () => {
              before(() => {
                helper.command.tagAllComponents();
              });
              it('should save the version from package.json into the scope', () => {
                const barFoo = helper.command.catComponent(`${helper.scopes.remote}/bar/foo@latest`);
                expect(barFoo.dependencies[0].id.version).to.equal('0.0.1');
              });
              it('bit status should not show the component as modified', () => {
                const status = helper.command.status();
                expect(status).to.not.have.string('modified');
              });
            });
          });
        });
        describe('import dependency and dependent with the same command', () => {
          describe('when the dependent comes before the dependency', () => {
            before(() => {
              helper.scopeHelper.getClonedLocalScope(beforeImportScope);
              helper.command.importManyComponents(['bar/foo', 'utils/is-string']);
            });
            it('should write the path of the dependency into the dependent package.json instead of the version', () => {
              const packageJson = helper.packageJson.read(path.join(helper.scopes.localPath, 'components/bar/foo'));
              expect(packageJson.dependencies[`@ci/${helper.scopes.remote}.utils.is-string`]).to.equal(
                'file:../../utils/is-string'
              );
            });
          });
          describe('when the dependency comes before the dependent', () => {
            before(() => {
              helper.scopeHelper.getClonedLocalScope(beforeImportScope);
              helper.command.importManyComponents(['utils/is-string', 'bar/foo']);
            });
            it('should write the path of the dependency into the dependent package.json instead of the version', () => {
              const packageJson = helper.packageJson.read(path.join(helper.scopes.localPath, 'components/bar/foo'));
              expect(packageJson.dependencies[`@ci/${helper.scopes.remote}.utils.is-string`]).to.equal(
                'file:../../utils/is-string'
              );
            });
          });
        });
        describe('isolating with capsule', () => {
          let capsuleDir;
          before(() => {
            helper.scopeHelper.getClonedLocalScope(afterImportScope);
            capsuleDir = helper.general.generateRandomTmpDirName();
            helper.command.runCmd(
              `bit isolate ${helper.scopes.remote}/bar/foo --use-capsule --directory ${capsuleDir}`
            );
            fs.outputFileSync(path.join(capsuleDir, 'app.js'), fixtures.appPrintBarFooCapsule);
          });
          it('should have the components and dependencies installed correctly with all the links', () => {
            const result = helper.command.runCmd('node app.js', capsuleDir);
            expect(result.trim()).to.equal('got is-type and got is-string and got foo');
          });
        });
      });
    });
    describe('components with nested dependencies and compiler', () => {
      before(async () => {
        helper = new Helper();
        npmCiRegistry = new NpmCiRegistry(helper);
        await npmCiRegistry.init();
        helper.scopeHelper.setNewLocalAndRemoteScopes();
        npmCiRegistry.setCiScopeInBitJson();
        helper.fs.createFile('utils', 'is-type.js', fixtures.isType);
        helper.fixtures.addComponentUtilsIsType();
        helper.fs.createFile('utils', 'is-string.js', fixtures.isString);
        helper.fixtures.addComponentUtilsIsString();
        helper.fixtures.createComponentBarFoo(fixtures.barFooFixture);
        helper.fixtures.addComponentBarFoo();
        helper.env.importCompiler();
        helper.command.tagAllComponents();
        helper.command.exportAllComponents();
        helper.scopeHelper.reInitLocalScope();
        helper.scopeHelper.addRemoteScope();
        helper.command.importComponent('bar/foo');
        helper.command.importComponent('utils/is-type');
        helper.command.importComponent('utils/is-string');

        helper.extensions.importNpmPackExtension();
        helper.scopeHelper.removeRemoteScope();
        npmCiRegistry.publishComponent('utils/is-type');
        npmCiRegistry.publishComponent('utils/is-string');
        npmCiRegistry.publishComponent('bar/foo');
      });
      after(() => {
        npmCiRegistry.destroy();
      });
      describe('installing a component using NPM', () => {
        before(() => {
          helper.scopeHelper.reInitLocalScope();
          helper.command.runCmd('npm init -y');
          helper.command.runCmd(`npm install @ci/${helper.scopes.remote}.bar.foo`);
        });
        it('should be able to require its direct dependency and print results from all dependencies', () => {
          const appJsFixture = `const barFoo = require('@ci/${helper.scopes.remote}.bar.foo'); console.log(barFoo());`;
          fs.outputFileSync(path.join(helper.scopes.localPath, 'app.js'), appJsFixture);
          const result = helper.command.runCmd('node app.js');
          expect(result.trim()).to.equal('got is-type and got is-string and got foo');
        });
      });
      describe('importing a component using Bit', () => {
        let beforeImportScope;
        before(() => {
          helper.scopeHelper.reInitLocalScope();
          npmCiRegistry.setCiScopeInBitJson();
          npmCiRegistry.setResolver();
          beforeImportScope = helper.scopeHelper.cloneLocalScope();
          helper.command.importComponent('bar/foo');
        });
        it('bit status should not show any error', () => {
          const output = helper.command.runCmd('bit status');
          expect(output).to.have.a.string(statusWorkspaceIsCleanMsg);
        });
        it('should be able to require its direct dependency and print results from all dependencies', () => {
          const appJsFixture = "const barFoo = require('./components/bar/foo'); console.log(barFoo());";
          fs.outputFileSync(path.join(helper.scopes.localPath, 'app.js'), appJsFixture);
          const result = helper.command.runCmd('node app.js');
          expect(result.trim()).to.equal('got is-type and got is-string and got foo');
        });
        describe('deleting the dependency package from the FS', () => {
          before(() => {
            helper.fs.deletePath('components/bar/foo/node_modules/@ci');
          });
          it('bit status should show missing components and not untracked components', () => {
            const status = helper.command.status();
            expect(status).to.have.string(componentIssuesLabels.missingComponents);
            expect(status).not.to.have.string(componentIssuesLabels.untrackedDependencies);
          });
        });
        describe('import with dist outside the component directory', () => {
          before(() => {
            helper.scopeHelper.getClonedLocalScope(beforeImportScope);
            helper.bitJson.modifyField('dist', { target: 'dist' });
            helper.command.importComponent('bar/foo');
          });
          it('bit status should not show any error', () => {
            const output = helper.command.runCmd('bit status');
            expect(output).to.have.a.string(statusWorkspaceIsCleanMsg);
          });
          describe('running bit link after deleting the symlink from dist directory', () => {
            let symlinkPath;
            before(() => {
              symlinkPath = 'dist/components/bar/foo/node_modules/@ci';
              helper.fs.deletePath(symlinkPath);
              helper.command.runCmd('bit link');
            });
            it('should recreate the symlink with the correct path', () => {
              const expectedDest = path.join(helper.scopes.localPath, symlinkPath);
              expect(expectedDest).to.be.a.path();
              const symlinkValue = fs.readlinkSync(expectedDest);
              expect(symlinkValue).to.have.string(
                path.join(helper.scopes.local, 'components/bar/foo/node_modules/@ci')
              );
            });
          });
        });
      });
    });
  }
);
