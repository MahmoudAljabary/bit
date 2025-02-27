/** @flow */
import path from 'path';
import R from 'ramda';
import glob from 'glob';
import { BitId } from '../bit-id';
import type Component from '../consumer/component/consumer-component';
import { COMPONENT_ORIGINS, PACKAGE_JSON, DEFAULT_BINDINGS_PREFIX } from '../constants';
import type ComponentMap from '../consumer/bit-map/component-map';
import logger from '../logger/logger';
import { first } from '../utils';
import type Consumer from '../consumer/consumer';
import { getComponentsDependenciesLinks } from './link-generator';
import { getLinkToFileContent } from './link-content';
import type { PathOsBasedRelative } from '../utils/path';
import getNodeModulesPathOfComponent from '../utils/bit/component-node-modules-path';
import type { Dependency } from '../consumer/component/dependencies';
import BitMap from '../consumer/bit-map/bit-map';
import Symlink from './symlink';
import DataToPersist from '../consumer/component/sources/data-to-persist';
import LinkFile from './link-file';
import ComponentsList from '../consumer/component/components-list';
import PackageJsonFile from '../consumer/component/package-json-file';
import { getPathRelativeRegardlessCWD } from '../utils/path';
import RemovePath from '../consumer/component/sources/remove-path';

type LinkDetail = { from: string, to: string };
export type LinksResult = {
  id: BitId,
  bound: LinkDetail[]
};

/**
 * link given components to node_modules, so it's possible to use absolute link instead of relative
 * for example, require('@bit/remote-scope.bar.foo)
 */
export default class NodeModuleLinker {
  components: Component[];
  consumer: ?Consumer;
  bitMap: BitMap; // preparation for the capsule, which is going to have only BitMap with no Consumer
  dataToPersist: DataToPersist;
  constructor(components: Component[], consumer: ?Consumer, bitMap: BitMap) {
    this.components = ComponentsList.getUniqueComponents(components);
    this.consumer = consumer;
    this.bitMap = bitMap;
    this.dataToPersist = new DataToPersist();
  }
  async link(): Promise<LinksResult[]> {
    const links = await this.getLinks();
    const linksResults = this.getLinksResults();
    if (this.consumer) links.addBasePath(this.consumer.getPath());
    await links.persistAllToFS();
    return linksResults;
  }
  async getLinks(): Promise<DataToPersist> {
    this.dataToPersist = new DataToPersist();
    await this._populateShouldDependenciesSavedAsComponentsData();
    await Promise.all(
      this.components.map((component) => {
        const componentId = component.id.toString();
        logger.debug(`linking component to node_modules: ${componentId}`);
        const componentMap: ComponentMap = this.bitMap.getComponent(component.id);
        component.componentMap = componentMap;
        switch (componentMap.origin) {
          case COMPONENT_ORIGINS.IMPORTED:
            return this._populateImportedComponentsLinks(component);
          case COMPONENT_ORIGINS.NESTED:
            return this._populateNestedComponentsLinks(component);
          case COMPONENT_ORIGINS.AUTHORED:
            return this._populateAuthoredComponentsLinks(component);
          default:
            throw new Error(`ComponentMap.origin ${componentMap.origin} of ${componentId} is not recognized`);
        }
      })
    );

    return this.dataToPersist;
  }
  getLinksResults(): LinksResult[] {
    const linksResults: LinksResult[] = [];
    const getExistingLinkResult = id => linksResults.find(linkResult => linkResult.id.isEqual(id));
    const addLinkResult = (id: ?BitId, from: string, to: string) => {
      if (!id) return;
      const existingLinkResult = getExistingLinkResult(id);
      if (existingLinkResult) {
        existingLinkResult.bound.push({ from, to });
      } else {
        linksResults.push({ id, bound: [{ from, to }] });
      }
    };
    this.dataToPersist.symlinks.forEach((symlink: Symlink) => {
      addLinkResult(symlink.componentId, symlink.src, symlink.dest);
    });
    this.dataToPersist.files.forEach((file: LinkFile) => {
      addLinkResult(file.componentId, file.srcPath, file.path);
    });
    this.components.forEach((component) => {
      const existingLinkResult = getExistingLinkResult(component.id);
      if (!existingLinkResult) {
        linksResults.push({ id: component.id, bound: [] });
      }
    });
    return linksResults;
  }
  async _populateImportedComponentsLinks(component: Component): Promise<void> {
    const componentMap = component.componentMap;
    const componentId = component.id;
    const bindingPrefix = this.consumer ? this.consumer.config.bindingPrefix : DEFAULT_BINDINGS_PREFIX;
    const linkPath: PathOsBasedRelative = getNodeModulesPathOfComponent(bindingPrefix, componentId, true);
    // when a user moves the component directory, use component.writtenPath to find the correct target
    // $FlowFixMe
    const srcTarget: PathOsBasedRelative = component.writtenPath || componentMap.rootDir;
    const shouldDistsBeInsideTheComponent = this.consumer ? this.consumer.shouldDistsBeInsideTheComponent() : true;
    if (
      this.consumer &&
      !component.dists.isEmpty() &&
      component.dists.writeDistsFiles &&
      !shouldDistsBeInsideTheComponent
    ) {
      const distTarget = component.dists.getDistDir(this.consumer, componentMap.getRootDir());
      const packagesSymlinks = this._getSymlinkPackages(srcTarget, distTarget, component);
      this.dataToPersist.addManySymlinks(packagesSymlinks);
      const distSymlink = Symlink.makeInstance(distTarget, linkPath, componentId);
      distSymlink.forDistOutsideComponentsDir = true;
      this.dataToPersist.addSymlink(distSymlink);
    } else if (srcTarget !== '.') {
      // avoid creating symlinks from node_modules to itself
      this.dataToPersist.addSymlink(Symlink.makeInstance(srcTarget, linkPath, componentId));
    }
    await this._populateDependenciesAndMissingLinks(component);
  }
  async _populateNestedComponentsLinks(component: Component): Promise<void> {
    await this._populateDependenciesAndMissingLinks(component);
  }

  _populateAuthoredComponentsLinks(component: Component): void {
    const componentId = component.id;
    const filesToBind = component.componentMap.getFilesRelativeToConsumer();
    component.dists.updateDistsPerWorkspaceConfig(component.id, this.consumer, component.componentMap);
    filesToBind.forEach((file) => {
      const isMain = file === component.componentMap.mainFile;
      const possiblyDist = component.dists.calculateDistFileForAuthored(path.normalize(file), this.consumer, isMain);
      const dest = path.join(getNodeModulesPathOfComponent(component.bindingPrefix, componentId, true), file);
      const destRelative = getPathRelativeRegardlessCWD(path.dirname(dest), possiblyDist);
      const fileContent = getLinkToFileContent(destRelative);
      if (fileContent) {
        const linkFile = LinkFile.load({
          filePath: dest,
          content: fileContent,
          srcPath: file,
          componentId,
          override: true
        });
        this.dataToPersist.addFile(linkFile);
      } else {
        // it's an un-supported file, create a symlink instead
        this.dataToPersist.addSymlink(Symlink.makeInstance(file, dest, componentId));
      }
    });
    this._deleteOldLinksOfIdWithoutScope(component);
    this._createPackageJsonForAuthor(component);
  }
  /**
   * for AUTHORED components, when a component is new, upon build, we generate links on
   * node_modules. The path doesn't have the scope-name as it doesn't exist yet. (e.g. @bit/foo).
   * Later on, when the component is exported and has a scope-name, the path is complete.
   * (e.g. @bit/scope.foo). At this stage, this function deletes the old-partial paths.
   */
  _deleteOldLinksOfIdWithoutScope(component: Component) {
    if (component.id.scope) {
      const previousDest = getNodeModulesPathOfComponent(component.bindingPrefix, component.id.changeScope(null), true);
      this.dataToPersist.removePath(new RemovePath(previousDest));
    }
  }
  /**
   * for IMPORTED and NESTED components
   */
  async _populateDependenciesAndMissingLinks(component: Component): Promise<void> {
    // $FlowFixMe loaded from FS, componentMap must be set
    const componentMap: ComponentMap = component.componentMap;
    if (component.hasDependencies()) {
      const dependenciesLinks = this._getDependenciesLinks(component, componentMap);
      this.dataToPersist.addManySymlinks(dependenciesLinks);
    }
    const missingDependenciesLinks =
      this.consumer && component.issues && component.issues.missingLinks ? this._getMissingLinks(component) : [];
    this.dataToPersist.addManySymlinks(missingDependenciesLinks);
    if (this.consumer && component.issues && component.issues.missingCustomModuleResolutionLinks) {
      const missingCustomResolvedLinks = await this._getMissingCustomResolvedLinks(component);
      this.dataToPersist.addManyFiles(missingCustomResolvedLinks.files);
      this.dataToPersist.addManySymlinks(missingCustomResolvedLinks.symlinks);
      if (component.componentFromModel && component.componentFromModel.hasDependencies()) {
        // when custom-resolve links are missing, the component has been loaded without that
        // dependency. (see "deleting the link generated for the custom-module-resolution" test)
        // as a result, dependency links were not generated. our option is to get it from the scope
        const dependenciesLinks = this._getDependenciesLinks(component.componentFromModel, componentMap);
        this.dataToPersist.addManySymlinks(dependenciesLinks);
      }
    }
  }
  /**
   * When the dists is outside the components directory, it doesn't have access to the node_modules of the component's
   * root-dir. The solution is to go through the node_modules packages one by one and symlink them.
   */
  _getSymlinkPackages(from: string, to: string, component: Component): Symlink[] {
    if (!this.consumer) throw new Error('getSymlinkPackages expects the Consumer to be defined');
    const dependenciesSavedAsComponents = component.dependenciesSavedAsComponents;
    const fromNodeModules = path.join(from, 'node_modules');
    const toNodeModules = path.join(to, 'node_modules');
    logger.debug(
      `symlinkPackages for dists outside the component directory from ${fromNodeModules} to ${toNodeModules}`
    );
    const unfilteredDirs = glob.sync('*', { cwd: fromNodeModules });
    // when dependenciesSavedAsComponents the node_modules/@bit has real link files, we don't want to touch them
    // otherwise, node_modules/@bit has packages as any other directory in node_modules
    const dirsToFilter = dependenciesSavedAsComponents ? [this.consumer.config.bindingPrefix] : [];
    const customResolvedData = component.dependencies.getCustomResolvedData();
    if (!R.isEmpty(customResolvedData)) {
      // filter out packages that are actually symlinks to dependencies
      Object.keys(customResolvedData).forEach(importSource => dirsToFilter.push(first(importSource.split('/'))));
    }
    const dirs = dirsToFilter.length ? unfilteredDirs.filter(dir => !dirsToFilter.includes(dir)) : unfilteredDirs;
    if (!dirs.length) return [];
    return dirs.map((dir) => {
      const fromDir = path.join(fromNodeModules, dir);
      const toDir = path.join(toNodeModules, dir);
      return Symlink.makeInstance(fromDir, toDir);
    });
  }

  _getDependenciesLinks(component: Component, componentMap: ComponentMap): Symlink[] {
    const getSymlinks = (dependency: Dependency): Symlink[] => {
      const dependencyComponentMap = this.bitMap.getComponentIfExist(dependency.id);
      const dependenciesLinks: Symlink[] = [];
      if (!dependencyComponentMap || !dependencyComponentMap.rootDir) return dependenciesLinks;
      const parentRootDir = componentMap.getRootDir();
      const dependencyRootDir = dependencyComponentMap.getRootDir();
      dependenciesLinks.push(
        this._getDependencyLink(parentRootDir, dependency.id, dependencyRootDir, component.bindingPrefix)
      );
      if (this.consumer && !this.consumer.shouldDistsBeInsideTheComponent()) {
        // when dists are written outside the component, it doesn't matter whether a component
        // has dists files or not, in case it doesn't have, the files are copied from the component
        // dir into the dist dir. (see consumer-component.write())
        const from = component.dists.getDistDirForConsumer(this.consumer, parentRootDir);
        const to = component.dists.getDistDirForConsumer(this.consumer, dependencyRootDir);
        const distSymlink = this._getDependencyLink(from, dependency.id, to, component.bindingPrefix);
        distSymlink.forDistOutsideComponentsDir = true;
        dependenciesLinks.push(distSymlink);
      }
      return dependenciesLinks;
    };
    const symlinks = component.getAllDependencies().map((dependency: Dependency) => getSymlinks(dependency));
    return R.flatten(symlinks);
  }

  _getMissingLinks(component: Component): Symlink[] {
    const missingLinks = component.issues.missingLinks;
    const result = Object.keys(component.issues.missingLinks).map((key) => {
      return missingLinks[key]
        .map((dependencyIdRaw: BitId) => {
          const dependencyId: BitId = this.bitMap.getBitId(dependencyIdRaw, { ignoreVersion: true });
          const dependencyComponentMap = this.bitMap.getComponent(dependencyId);
          if (!dependencyComponentMap.rootDir) return null;
          return this._getDependencyLink(
            component.componentMap.rootDir,
            dependencyId,
            dependencyComponentMap.rootDir,
            component.bindingPrefix
          );
        })
        .filter(x => x);
    });
    return R.flatten(result);
  }

  _getDependencyLink(
    parentRootDir: PathOsBasedRelative,
    bitId: BitId,
    rootDir: PathOsBasedRelative,
    bindingPrefix: string
  ): Symlink {
    const relativeDestPath = getNodeModulesPathOfComponent(bindingPrefix, bitId, true);
    const destPathInsideParent = path.join(parentRootDir, relativeDestPath);
    return Symlink.makeInstance(rootDir, destPathInsideParent, bitId);
  }

  async _getMissingCustomResolvedLinks(component: Component): Promise<DataToPersist> {
    if (!component.componentFromModel) return new DataToPersist();
    if (!this.consumer) throw new Error('_getMissingCustomResolvedLinks expects to have consumer set');
    const componentWithDependencies = await component.toComponentWithDependencies(this.consumer);
    const missingLinks = component.issues.missingCustomModuleResolutionLinks;
    const dependenciesStr = R.flatten(Object.keys(missingLinks).map(fileName => missingLinks[fileName]));
    component.copyDependenciesFromModel(dependenciesStr);
    const componentsDependenciesLinks = getComponentsDependenciesLinks(
      [componentWithDependencies],
      this.consumer,
      false,
      this.bitMap
    );
    return componentsDependenciesLinks;
  }

  /**
   * create package.json on node_modules/@bit/component-name/package.json with a property 'main'
   * pointing to the component's main file.
   * It is needed for Authored components only.
   * Since an authored component doesn't have rootDir, it's impossible to symlink to the component directory.
   * It makes it easier for Author to use absolute syntax between their own components.
   */
  _createPackageJsonForAuthor(component: Component) {
    const hasPackageJsonAsComponentFile = component.files.some(file => file.relative === PACKAGE_JSON);
    if (hasPackageJsonAsComponentFile) return; // don't generate package.json on top of the user package.json
    const dest = path.join(getNodeModulesPathOfComponent(component.bindingPrefix, component.id, true));
    const packageJson = PackageJsonFile.createFromComponent(dest, component);
    this.dataToPersist.addFile(packageJson.toVinylFile());
  }

  /**
   * links are normally generated by `bit import`, `bit link` and `bit install`.
   * for `bit import` the data about whether dependenciesSavedAsComponents is already populated
   * for the rest, it's not.
   * @todo: avoid repopulating for imported. (not easy because by default, all components get "true").
   */
  async _populateShouldDependenciesSavedAsComponentsData(): Promise<void> {
    if (!this.components.length || !this.consumer) return;
    const bitIds = this.components.map(c => c.id);
    const shouldDependenciesSavedAsComponents = await this.consumer.shouldDependenciesSavedAsComponents(bitIds);
    this.components.forEach((component) => {
      const shouldSavedAsComponents = shouldDependenciesSavedAsComponents.find(c => c.id.isEqual(component.id));
      if (!shouldSavedAsComponents) {
        throw new Error(
          `_populateShouldDependenciesSavedAsComponentsData, saveDependenciesAsComponents is missing for ${component.id.toString()}`
        );
      }
      component.dependenciesSavedAsComponents = shouldSavedAsComponents.saveDependenciesAsComponents;
    });
  }
}
